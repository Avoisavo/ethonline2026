// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Counter
/// @notice A minimal counter to verify contract deployment on Arc testnet.
contract Counter {
    uint256 public count;

    event Incremented(uint256 newCount);

    /// @notice Increment the counter by 1.
    function inc() public {
        count += 1;
        emit Incremented(count);
    }

    /// @notice Increment the counter by an arbitrary positive amount.
    function incBy(uint256 by) public {
        require(by > 0, "incBy: increment should be positive");
        count += by;
        emit Incremented(count);
    }
}
