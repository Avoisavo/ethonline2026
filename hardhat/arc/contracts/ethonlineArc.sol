// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ethonlineArc
/// @notice Minimal audit escrow on Arc.
///         A developer funds an audit FEE and the selected auditor posts a BOND; both
///         are locked here in USDC. On a clean audit the fee + bond are released to the
///         auditor; if the verdict is later proven wrong, the auditor's bond is SLASHED
///         to whoever reported it and the developer's fee is refunded.
///
/// @dev    DEMO / hackathon grade and intentionally PERMISSIONLESS: anyone can create a
///         job and anyone can trigger release()/slash() so each function is easy to test
///         from the UI. In production, gate release()/slash() behind the attested verdict
///         (Chainlink Confidential AI Attester) and a dispute window.
contract ethonlineArc {
    enum Status {
        None,     // 0 - never created
        Open,     // 1 - created, awaiting fee and/or bond
        Funded,   // 2 - fee + bond both locked
        Settled,  // 3 - clean audit: fee + bond paid to auditor
        Slashed   // 4 - wrong verdict: bond -> reporter, fee refunded to developer
    }

    struct Job {
        address developer; // pays the audit fee
        address auditor;   // posts the bond
        uint256 fee;       // audit fee  (USDC base units, 6 decimals)
        uint256 bond;      // honesty bond (USDC base units, 6 decimals)
        bool feeFunded;
        bool bondPosted;
        Status status;
    }

    IERC20 public immutable usdc;
    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    event JobCreated(uint256 indexed jobId, address indexed developer, address indexed auditor, uint256 fee, uint256 bond);
    event TermsSet(uint256 indexed jobId, uint256 fee, uint256 bond);
    event FeeFunded(uint256 indexed jobId, address indexed from, uint256 amount);
    event BondPosted(uint256 indexed jobId, address indexed from, uint256 amount);
    event Funded(uint256 indexed jobId);
    event Released(uint256 indexed jobId, address indexed auditor, uint256 fee, uint256 bond);
    event Slashed(uint256 indexed jobId, address indexed reporter, uint256 bond, address indexed developer, uint256 feeRefunded);

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }

    /// @notice Create a new audit job. Returns its id.
    /// @dev    fee/bond MAY be 0 at creation — open the job first, then set the agreed price
    ///         later with setTerms() once the negotiation finishes. fundFee()/postBond()
    ///         enforce a non-zero price, so a 0/0 draft can never be funded by accident.
    function createJob(address developer, address auditor, uint256 fee, uint256 bond)
        external
        returns (uint256 jobId)
    {
        require(developer != address(0) && auditor != address(0), "zero address");
        jobId = nextJobId++;
        jobs[jobId] = Job({
            developer: developer,
            auditor: auditor,
            fee: fee,
            bond: bond,
            feeFunded: false,
            bondPosted: false,
            status: Status.Open
        });
        emit JobCreated(jobId, developer, auditor, fee, bond);
    }

    /// @notice Set / replace the agreed fee + bond after creation — the "fill in the price
    ///         once the discussion finishes" step. Allowed only while the job is Open and
    ///         before either side has funded (so locked amounts can't be changed under you).
    function setTerms(uint256 jobId, uint256 fee, uint256 bond) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open, "job not open");
        require(!j.feeFunded && !j.bondPosted, "already funding");
        j.fee = fee;
        j.bond = bond;
        emit TermsSet(jobId, fee, bond);
    }

    /// @notice Developer locks the audit fee. The amount is passed HERE (so the UI can set it at
    ///         fund time, independently of the bond) and is recorded on the job. The developer
    ///         must approve() this contract for at least `fee` on the USDC token first.
    function fundFee(uint256 jobId, uint256 fee) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open, "job not open");
        require(!j.feeFunded, "fee already funded");
        require(fee > 0, "fee must be > 0");
        j.fee = fee;
        j.feeFunded = true;
        require(usdc.transferFrom(j.developer, address(this), fee), "fee transfer failed");
        emit FeeFunded(jobId, j.developer, fee);
        _settleFundedState(jobId, j);
    }

    /// @notice Selected auditor locks the bond. The amount is passed HERE (independently of the
    ///         fee) and recorded on the job. The auditor must approve() this contract for at
    ///         least `bond` on the USDC token first.
    function postBond(uint256 jobId, uint256 bond) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open, "job not open");
        require(!j.bondPosted, "bond already posted");
        require(bond > 0, "bond must be > 0");
        j.bond = bond;
        j.bondPosted = true;
        require(usdc.transferFrom(j.auditor, address(this), bond), "bond transfer failed");
        emit BondPosted(jobId, j.auditor, bond);
        _settleFundedState(jobId, j);
    }

    function _settleFundedState(uint256 jobId, Job storage j) internal {
        if (j.feeFunded && j.bondPosted) {
            j.status = Status.Funded;
            emit Funded(jobId);
        }
    }

    /// @notice Clean audit -> release the fee + bond to the auditor.
    /// @dev    Demo: anyone may call once the job is fully funded.
    function release(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Funded, "job not funded");
        j.status = Status.Settled;
        require(usdc.transfer(j.auditor, j.fee + j.bond), "release transfer failed");
        emit Released(jobId, j.auditor, j.fee, j.bond);
    }

    /// @notice Wrong verdict caught -> slash the bond to `reporter`, refund fee to developer.
    /// @dev    Demo: anyone may call once the job is fully funded.
    function slash(uint256 jobId, address reporter) external {
        require(reporter != address(0), "zero reporter");
        Job storage j = jobs[jobId];
        require(j.status == Status.Funded, "job not funded");
        j.status = Status.Slashed;
        require(usdc.transfer(reporter, j.bond), "bond payout failed");
        require(usdc.transfer(j.developer, j.fee), "fee refund failed");
        emit Slashed(jobId, reporter, j.bond, j.developer, j.fee);
    }

    /// @notice Read full job state in one call (handy for the UI).
    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
