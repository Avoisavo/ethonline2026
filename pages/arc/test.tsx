import { useCallback, useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { formatUnits, parseUnits } from "viem";
import {
  ESCROW_ABI,
  ESCROW_ADDRESS,
  GATEWAY_BATCHED_NAME,
  GATEWAY_BATCHED_VERSION,
  GATEWAY_WALLET,
  GATEWAY_WALLET_ABI,
  STATUS_LABELS,
  USDC_ABI,
  USDC_ADDRESS,
  USDC_DECIMALS,
  X402_MAX_TIMEOUT,
  X402_NETWORK,
  arcTestnet,
  explorerAddress,
  explorerTx,
} from "@/lib/arc/escrow";
import ArcProviders from "@/components/arc/ArcProviders";

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (v?: bigint) => (v == null ? "—" : formatUnits(v, USDC_DECIMALS));

function EscrowTest() {
  // avoid SSR/hydration mismatch from wallet state
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const onArc = chainId === arcTestnet.id;

  const [jobId, setJobId] = useState(0);
  const [pendingJobId, setPendingJobId] = useState<number | null>(null);
  const [approveAmt, setApproveAmt] = useState("100");
  const [fee, setFee] = useState("0.01");
  const [bond, setBond] = useState("0.02");
  const [reporter, setReporter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [bondBusy, setBondBusy] = useState(false);
  const [flowMsg, setFlowMsg] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState("");
  const [loggedHash, setLoggedHash] = useState<string | undefined>();
  const [log, setLog] = useState<{ action: string; hash: string; ok: boolean }[]>([]);
  const [x402, setX402] = useState<{
    busy?: boolean;
    error?: string;
    jobId?: number;
    agent?: string;
    author?: string;
    auditor?: string;
    authorPct?: number;
    total?: string;
    payments?: { role: string; to: string; amount: string; tx: string }[];
    verifiedLink?: string;
  }>({});
  const [payJobId, setPayJobId] = useState("");
  const [split, setSplit] = useState(80); // author %
  const [bals, setBals] = useState<Record<string, { available?: string; pending?: string }>>({});
  const [jobs, setJobs] = useState<
    { id: number; developer: string; auditor: string; fee: bigint; bond: bigint; feeFunded: boolean; bondPosted: boolean; status: number }[]
  >([]);
  const [reg, setReg] = useState<{ busy?: boolean; error?: string; done?: boolean; tx?: string }>({});
  const [regAmt, setRegAmt] = useState("0.2");
  const [gwBal, setGwBal] = useState<string | null>(null);
  const [gwPending, setGwPending] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ address?: string; walletUsdc?: string; gatewayAvailable?: string; gatewayPending?: string } | null>(null);

  // ---- reads ----
  const usdcBal = useReadContract({
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });
  const escrowBal = useReadContract({
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf",
    args: [ESCROW_ADDRESS],
  });
  const allowance = useReadContract({
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance",
    args: address ? [address, ESCROW_ADDRESS] : undefined, query: { enabled: !!address },
  });
  const nextJobId = useReadContract({
    address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "nextJobId",
  });
  const job = useReadContract({
    address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob",
    args: jobId ? [BigInt(jobId)] : undefined, query: { enabled: jobId > 0 },
  });

  const refetchAll = () => {
    usdcBal.refetch(); escrowBal.refetch(); allowance.refetch();
    nextJobId.refetch(); if (jobId) job.refetch();
  };

  // ---- writes ----
  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract();
  const publicClient = usePublicClient();
  const { writeContractAsync: writeRegister } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  const { data: receipt, isLoading: confirming, error: receiptError } =
    useWaitForTransactionReceipt({ hash });
  const succeeded = receipt?.status === "success";
  const reverted = receipt?.status === "reverted";

  useEffect(() => {
    if (receipt && hash && hash !== loggedHash) {
      setLoggedHash(hash);
      setLog((l) =>
        [{ action: lastAction, hash, ok: receipt.status === "success" }, ...l].slice(0, 30),
      );
      refetchAll();
      if (receipt.status === "success" && pendingJobId != null) {
        setJobId(pendingJobId);
        setPendingJobId(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, hash]);

  // Load all jobs from the escrow (for the live sidebar), newest first. Reloads after each tx.
  const loadJobs = useCallback(async () => {
    if (!publicClient) return;
    const n = Number(nextJobId.data ?? 1n);
    const ids = Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1);
    const rows = await Promise.all(
      ids.map((id) =>
        publicClient
          .readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(id)] })
          .then((j) => ({ id, ...j }))
          .catch(() => null),
      ),
    );
    setJobs(rows.filter((r): r is NonNullable<typeof r> => r !== null).reverse());
  }, [publicClient, nextJobId.data]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs, receipt]);

  const amt = (v: string) => parseUnits(v || "0", USDC_DECIMALS);
  const busy = isPending || confirming;
  const allowanceNum = Number(formatUnits((allowance.data as bigint) ?? 0n, USDC_DECIMALS));
  const errMsg =
    (writeError as { shortMessage?: string; message?: string } | null)?.shortMessage ||
    (writeError as { message?: string } | null)?.message ||
    (receiptError as { shortMessage?: string } | null)?.shortMessage ||
    (reverted ? "Transaction reverted on-chain — check the function's requirements below." : "");
  const stage = writeError
    ? "Error"
    : isPending
      ? "Awaiting wallet signature…"
      : confirming
        ? "Pending on-chain…"
        : succeeded
          ? "Confirmed ✓"
          : reverted
            ? "Reverted ✕"
            : "Idle";

  const doApprove = () => {
    setLastAction("approve");
    writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, amt(approveAmt)] });
  };
  const doCreate = () => {
    if (!address) return;
    if (!agent?.address) { setFlowMsg("agent not loaded yet — Refresh"); return; }
    // fee/bond MAY be 0 here — open a price-less DRAFT first, then fill the agreed price with
    // "Set terms" once the negotiation finishes. (fundFee/postBond enforce a non-zero price
    // before anything is locked, so a 0/0 draft can never be funded by accident.)
    setFlowMsg(null);
    setPendingJobId(Number(nextJobId.data ?? 1n));
    setLastAction("createJob");
    // developer = you (author), auditor = the agent
    writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "createJob", args: [address, agent.address as `0x${string}`, amt(fee), amt(bond)] });
  };
  // Fill in / replace the agreed fee + bond on an existing Open job (the "after the discussion" step).
  const doSetTerms = () => { setFlowMsg(null); setLastAction("setTerms"); writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "setTerms", args: [BigInt(jobId), amt(fee), amt(bond)] }); };
  // v3 contract: fundFee(jobId, fee) / postBond(jobId, bond) take the amount directly — type the
  // number in section 3 and the click locks exactly that, each side independently (no setTerms dance).
  const doFund = () => {
    if (!jobId) return;
    setFlowMsg(null);
    setLastAction("fundFee");
    writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "fundFee", args: [BigInt(jobId), amt(fee)] });
  };
  // The agent (auditor) approves + posts the bond, server-side.
  const doBond = async () => {
    if (!jobId) return;
    setBondBusy(true);
    setFlowMsg(null);
    try {
      // pass the typed bond amount → the agent (auditor) posts exactly that, server-side
      const res = await fetch("/api/arc/agent-post-bond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, bond: amt(bond).toString() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFlowMsg(data.error || "post bond failed");
        return;
      }
      setLog((l) => [{ action: "postBond (agent)", hash: data.tx, ok: true }, ...l].slice(0, 30));
      refetchAll();
      loadJobs();
      fetchAgent();
    } catch (e) {
      setFlowMsg(String(e));
    } finally {
      setBondBusy(false);
    }
  };
  const doRelease = () => { setLastAction("release"); writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "release", args: [BigInt(jobId)] }); };
  const doSlash = () => {
    const r = (reporter || address) as `0x${string}`;
    setLastAction("slash");
    writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "slash", args: [BigInt(jobId), r] });
  };

  // The CONNECTED wallet pays per-use, gas-free: sign an EIP-3009 authorization
  // in-browser and POST it to the x402 seller, which settles via Circle Gateway.
  const signAndSettle = async (payTo: string, amountBase: number, jid: number, from: `0x${string}`) => {
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 600;
    const validBefore = now + X402_MAX_TIMEOUT;
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    const nonce = ("0x" + Array.from(rnd).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
    const signature = await signTypedDataAsync({
      domain: { name: GATEWAY_BATCHED_NAME, version: GATEWAY_BATCHED_VERSION, chainId: arcTestnet.id, verifyingContract: GATEWAY_WALLET },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from, to: payTo as `0x${string}`, value: BigInt(amountBase), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce },
    });
    const requirement = {
      scheme: "exact", network: X402_NETWORK, asset: USDC_ADDRESS, amount: String(amountBase), payTo,
      maxTimeoutSeconds: X402_MAX_TIMEOUT,
      extra: { name: GATEWAY_BATCHED_NAME, version: GATEWAY_BATCHED_VERSION, verifyingContract: GATEWAY_WALLET },
    };
    const authorization = { from, to: payTo, value: String(amountBase), validAfter: String(validAfter), validBefore: String(validBefore), nonce };
    const headerVal = btoa(
      JSON.stringify({
        x402Version: 2,
        payload: { authorization, signature },
        resource: { url: `${window.location.origin}/api/arc/skill`, description: "ethonlineArc verified skill", mimeType: "application/json" },
        accepted: requirement,
      }),
    );
    const res = await fetch(`/api/arc/skill?payTo=${payTo}&amount=${amountBase}&jobId=${jid}`, { headers: { "Payment-Signature": headerVal } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "settlement failed");
    return data as { verifiedLink?: string; settlementTx?: string };
  };

  const buySkill = async () => {
    if (!isConnected || !address) return setX402({ error: "connect a wallet to pay" });
    if (!onArc) return setX402({ error: "switch to Arc Testnet first" });
    const jid = Number(payJobId || jobId);
    if (!jid) return setX402({ error: "pick a job (tap one in Jobs)" });
    const j = jobs.find((x) => x.id === jid);
    if (!j) return setX402({ error: `job #${jid} not loaded — Refresh` });
    if (gwBal != null && Number(gwBal) < 0.01) {
      return setX402({ error: "your Gateway balance is too low — Register / deposit first (step 0)" });
    }

    const author = j.developer;
    const auditor = j.auditor;
    const total = 10000;
    const authorAmt = Math.round((total * split) / 100);
    const auditorAmt = total - authorAmt;
    const recipients =
      author.toLowerCase() === auditor.toLowerCase()
        ? [{ role: "author+auditor", to: author, amount: total }]
        : [
            ...(authorAmt > 0 ? [{ role: "author", to: author, amount: authorAmt }] : []),
            ...(auditorAmt > 0 ? [{ role: "auditor", to: auditor, amount: auditorAmt }] : []),
          ];
    for (const r of recipients) {
      if (r.to.toLowerCase() === address.toLowerCase()) {
        return setX402({ error: `${r.role} is your own wallet (self-transfer). Pay a skill you didn't author.` });
      }
    }

    setX402({ busy: true });
    setBals({});
    try {
      const payments: { role: string; to: string; amount: string; tx: string }[] = [];
      let verifiedLink: string | undefined;
      for (const r of recipients) {
        const data = await signAndSettle(r.to, r.amount, jid, address);
        payments.push({ role: r.role, to: r.to, amount: formatUnits(BigInt(r.amount), 6), tx: data.settlementTx ?? "" });
        verifiedLink = data.verifiedLink ?? verifiedLink;
      }
      setX402({
        jobId: jid,
        agent: address,
        author,
        auditor,
        authorPct: split,
        total: formatUnits(BigInt(total), 6),
        payments,
        verifiedLink,
      });
    } catch (e) {
      setX402({ error: (e as Error).message || "payment failed" });
    }
  };

  // Read the connected wallet's Circle Gateway balance (proof of registration).
  const fetchGwBal = useCallback(async () => {
    if (!address) {
      setGwBal(null);
      setGwPending(null);
      return;
    }
    try {
      const r = await fetch(`/api/arc/gateway-balance?address=${address}`);
      const d = await r.json();
      setGwBal(d.available ?? "0");
      setGwPending(d.pendingBatch ?? "0");
    } catch {
      setGwBal(null);
    }
  }, [address]);

  // The agent wallet (ARC_PRIVATE_KEY): on-chain USDC + Gateway balance.
  const fetchAgent = useCallback(async () => {
    try {
      const r = await fetch("/api/arc/agent");
      const d = await r.json();
      if (d.address) setAgent(d);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchGwBal();
    fetchAgent();
  }, [fetchGwBal, fetchAgent]);

  // Read Gateway balances (available + pending) for payer + recipients — proof it landed.
  const refreshBals = useCallback(async () => {
    const addrs = [x402.agent, x402.author, x402.auditor].filter(Boolean) as string[];
    const uniq = [...new Set(addrs.map((a) => a.toLowerCase()))];
    await Promise.all(
      uniq.map(async (a) => {
        try {
          const r = await fetch(`/api/arc/gateway-balance?address=${a}`);
          const d = await r.json();
          setBals((prev) => ({ ...prev, [a]: { available: d.available, pending: d.pendingBatch } }));
        } catch {
          /* ignore */
        }
      }),
    );
  }, [x402.agent, x402.author, x402.auditor]);

  useEffect(() => {
    if (x402.agent) refreshBals();
  }, [x402.agent, refreshBals]);

  // One-time: register this wallet with Circle Gateway (approve + deposit).
  const registerGateway = async () => {
    if (!address || !publicClient) return;
    setReg({ busy: true });
    try {
      const amt = parseUnits(regAmt || "0.2", USDC_DECIMALS);
      const approveHash = await writeRegister({
        address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [GATEWAY_WALLET, amt],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      const depositHash = await writeRegister({
        address: GATEWAY_WALLET, abi: GATEWAY_WALLET_ABI, functionName: "deposit", args: [USDC_ADDRESS, amt], gas: 120000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
      setReg({ done: true, tx: depositHash });
      fetchGwBal();
      usdcBal.refetch();
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setReg({ error: err.shortMessage || err.message || "register failed" });
    }
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-950/60 p-4";
  const label = "text-xs uppercase tracking-wide text-zinc-500";
  const input = "w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500";
  const tones: Record<string, string> = {
    indigo: "bg-indigo-600 hover:bg-indigo-500",
    green: "bg-emerald-600 hover:bg-emerald-500",
    red: "bg-rose-600 hover:bg-rose-500",
    zinc: "bg-zinc-700 hover:bg-zinc-600",
  };
  const Btn = ({ onClick, children, tone = "indigo", disabled }: { onClick: () => void; children: React.ReactNode; tone?: string; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled || busy || !isConnected || !onArc}
      className={`rounded-md px-3 py-2 text-sm font-medium text-white transition disabled:opacity-40 ${tones[tone]}`}>
      {children}
    </button>
  );

  const jobData = job.data as
    | { developer: string; auditor: string; fee: bigint; bond: bigint; feeFunded: boolean; bondPosted: boolean; status: number }
    | undefined;

  const refreshAll = () => {
    refetchAll();
    loadJobs();
    fetchGwBal();
  };

  return (
    <div className="min-h-screen bg-black px-6 py-10 font-sans text-zinc-100">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-5 lg:grid-cols-3">
        <header className="flex flex-wrap items-start justify-between gap-3 lg:col-span-3">
          <div>
            <h1 className="text-2xl font-semibold">ethonlineArc Escrow — Arc Testnet</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Connect the wallet holding your faucet USDC, then: approve → fund fee → post bond →
              release (clean) or slash (wrong verdict). Real USDC at{" "}
              <a className="text-indigo-400 hover:underline" href={explorerAddress(USDC_ADDRESS)} target="_blank" rel="noreferrer">{short(USDC_ADDRESS)}</a>.
            </p>
          </div>
          {mounted && <ConnectButton />}
        </header>

        {mounted && isConnected && !onArc && (
          <div className="flex items-center justify-between rounded-xl border border-amber-700/50 bg-amber-900/20 p-4 text-sm text-amber-200 lg:col-span-3">
            <span>Wrong network — switch to Arc Testnet ({arcTestnet.id}).</span>
            <button onClick={() => switchChain({ chainId: arcTestnet.id })}
              className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-500">
              Switch to Arc
            </button>
          </div>
        )}

        {/* LEFT — interactive flow */}
        <main className="flex flex-col gap-5 lg:col-span-2">
          {!mounted || !isConnected ? (
            <div className={`${card} text-sm text-zinc-400`}>
              Connect a wallet to begin. Need test USDC? Get it from{" "}
              <a className="text-indigo-400 hover:underline" href="https://faucet.circle.com" target="_blank" rel="noreferrer">faucet.circle.com</a> (Arc Testnet).
            </div>
          ) : (
            <>
            {/* 0 register with gateway */}
            <div className={card}>
              <p className="mb-1 text-sm font-medium text-zinc-300">0 · Register this wallet with Circle Gateway (one-time)</p>
              <p className="mb-3 text-xs text-zinc-500">
                Deposits USDC into Gateway so this address can <strong>pay</strong> and <strong>receive</strong> x402
                nanopayments. Needed once per wallet — pops 2 confirmations (approve + deposit).
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <input className={input} value={regAmt} onChange={(e) => setRegAmt(e.target.value)} />
                <button
                  onClick={registerGateway}
                  disabled={reg.busy || !onArc}
                  className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
                >
                  {reg.busy ? "registering…" : "Register / deposit"}
                </button>
                <span className="text-sm text-zinc-400">
                  Gateway balance: <span className="font-medium text-zinc-100">{gwBal ?? "…"}</span> USDC
                </span>
                <button onClick={fetchGwBal} className="text-xs text-indigo-400 hover:underline">refresh</button>
              </div>
              {reg.error && (
                <p className="mt-3 rounded-md border border-rose-800/50 bg-rose-900/30 p-2 text-sm text-rose-300">{reg.error}</p>
              )}
              {reg.done && (
                <p className="mt-3 text-sm text-emerald-300">
                  ✓ Registered — this wallet now has a Gateway account.{" "}
                  {reg.tx && (
                    <a className="text-indigo-400 hover:underline" href={explorerTx(reg.tx)} target="_blank" rel="noreferrer">tx ↗</a>
                  )}
                </p>
              )}
            </div>

            {/* 1 approve */}
            <div className={card}>
              <p className="mb-3 text-sm font-medium text-zinc-300">1 · Approve USDC for the escrow</p>
              <div className="flex flex-wrap items-center gap-3">
                <input className={input} value={approveAmt} onChange={(e) => setApproveAmt(e.target.value)} />
                <Btn onClick={doApprove} tone="zinc">Approve</Btn>
                <span className="text-xs text-zinc-500">lets the escrow pull your fee + bond</span>
              </div>
            </div>

            {/* 2 create */}
            <div className={card}>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-300">2 · Create an audit job</p>
                {showCreate && (
                  <button onClick={() => setShowCreate(false)} className="text-xs text-zinc-500 hover:text-zinc-300">cancel</button>
                )}
              </div>
              {!showCreate ? (
                <button
                  onClick={() => setShowCreate(true)}
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
                >
                  Create
                </button>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1"><span className={label}>Fee</span><input className={input} value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0 = draft" /></div>
                  <div className="flex flex-col gap-1"><span className={label}>Bond</span><input className={input} value={bond} onChange={(e) => setBond(e.target.value)} placeholder="0 = draft" /></div>
                  <Btn onClick={doCreate}>Create job</Btn>
                  <Btn onClick={doSetTerms} disabled={!jobId}>Set terms</Btn>
                  <span className="text-xs text-zinc-500">create with 0/0 to open a draft, then <b className="text-zinc-300">Set terms</b> after the price is agreed · developer = you · auditor = agent {agent?.address ? short(agent.address) : "…"}</span>
                </div>
              )}
            </div>

            {/* 3 fund */}
            <div className={card}>
              <p className="mb-3 text-sm font-medium text-zinc-300">3 · Lock funds in escrow</p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1"><span className={label}>Fee</span><input className={input} value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0.01" /></div>
                <Btn onClick={doFund} disabled={!jobId}>Fund fee (you)</Btn>
                <div className="flex flex-col gap-1"><span className={label}>Bond</span><input className={input} value={bond} onChange={(e) => setBond(e.target.value)} placeholder="0.02" /></div>
                <button
                  onClick={doBond}
                  disabled={!jobId || bondBusy}
                  className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40"
                >
                  {bondBusy ? "agent posting…" : "Post bond (agent)"}
                </button>
                <span className="text-xs text-zinc-500">type each amount → that exact amount is locked on-chain · you fund the fee · the agent (auditor) posts the bond</span>
              </div>
              {allowanceNum <= 0 && (
                <p className="mt-2 text-xs text-amber-400">Your allowance is 0 — re-approve (step 1) before funding the fee.</p>
              )}
              {flowMsg && (
                <p className="mt-2 rounded-md border border-rose-800/50 bg-rose-900/30 p-2 text-xs text-rose-300">{flowMsg}</p>
              )}
            </div>

            {/* 4 settle */}
            <div className={card}>
              <p className="mb-3 text-sm font-medium text-zinc-300">4 · Settle the job</p>
              <div className="flex flex-wrap items-center gap-3">
                <Btn onClick={doRelease} tone="green" disabled={!jobId}>Release (clean)</Btn>
                <span className="text-xs text-zinc-500">→ fee + bond to auditor</span>
                <span className="mx-1 text-zinc-700">|</span>
                <input className={`${input} w-72`} placeholder="reporter (defaults to you)" value={reporter} onChange={(e) => setReporter(e.target.value)} />
                <Btn onClick={doSlash} tone="red" disabled={!jobId}>Slash</Btn>
                <span className="text-xs text-zinc-500">→ bond to reporter, fee back to dev</span>
              </div>
            </div>

            {/* job state */}
            {jobData && jobId > 0 && (
              <div className={card}>
                <p className="mb-3 text-sm font-medium text-zinc-300">Job #{jobId}</p>
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  <Stat k="Status"><Badge label={STATUS_LABELS[jobData.status] ?? "Unknown"} /></Stat>
                  <Stat k="Fee">{fmt(jobData.fee)}</Stat>
                  <Stat k="Bond">{fmt(jobData.bond)}</Stat>
                  <Stat k="Fee funded">{jobData.feeFunded ? "✅" : "—"}</Stat>
                  <Stat k="Bond posted">{jobData.bondPosted ? "✅" : "—"}</Stat>
                  <Stat k="Auditor">{short(jobData.auditor)}</Stat>
                </div>
              </div>
            )}

            {/* transaction detail */}
            <div className={card}>
              <p className="mb-3 text-sm font-medium text-zinc-300">Transaction detail</p>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <Stat k="Last action">{lastAction || "—"}</Stat>
                <Stat k="Stage">
                  <span
                    className={
                      stage === "Error" || stage.startsWith("Reverted")
                        ? "text-rose-400"
                        : stage.startsWith("Confirmed")
                          ? "text-emerald-400"
                          : stage === "Idle"
                            ? "text-zinc-400"
                            : "text-indigo-300"
                    }
                  >
                    {stage}
                  </span>
                </Stat>
                <Stat k="Tx">
                  {hash ? (
                    <a className="text-indigo-400 hover:underline" href={explorerTx(hash)} target="_blank" rel="noreferrer">{short(hash)} ↗</a>
                  ) : (
                    "—"
                  )}
                </Stat>
              </div>
              {errMsg && (
                <p className="mt-3 rounded-md border border-rose-800/50 bg-rose-900/30 p-2 text-sm text-rose-300">{errMsg}</p>
              )}
            </div>

            </>
          )}

          {/* 5 · agent pays per-use, fee split author/auditor (x402 nanopayment) */}
          {mounted && (
            <div className="rounded-xl border border-fuchsia-900/50 bg-fuchsia-950/20 p-4">
            <p className="mb-1 text-sm font-medium text-zinc-200">5 · Use a verified skill — split the fee author / auditor (x402 nanopayment)</p>
            <p className="mb-3 text-xs text-zinc-500">
              <strong>You</strong> (your connected wallet) pay 0.01 USDC <strong>gas-free</strong> via Circle Gateway (x402), split between the
              job&apos;s <strong>author</strong> and <strong>auditor</strong> by the slider — one gas-free signature per recipient. You must be
              registered (step 0) and can&apos;t pay a skill you authored.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-zinc-500">Pay for job #</span>
                <input className={input} placeholder={jobId ? String(jobId) : "e.g. 3"} value={payJobId} onChange={(e) => setPayJobId(e.target.value)} />
              </div>
              <div className="flex min-w-[16rem] flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-zinc-500">
                  Split — author <span className="text-fuchsia-300">{split}%</span> / auditor <span className="text-amber-300">{100 - split}%</span>
                </span>
                <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="accent-fuchsia-500" />
              </div>
              <button onClick={buySkill} disabled={x402.busy}
                className="rounded-md bg-fuchsia-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-fuchsia-500 disabled:opacity-40">
                {x402.busy ? "paying…" : "Pay 0.01 USDC (split, x402)"}
              </button>
            </div>
            {x402.error && (
              <p className="mt-3 rounded-md border border-rose-800/50 bg-rose-900/30 p-2 text-sm text-rose-300">{x402.error}</p>
            )}
            {x402.payments && (
              <div className="mt-3 rounded-md border border-emerald-800/50 bg-emerald-900/20 p-3 text-sm">
                <p className="text-emerald-300">
                  ✓ Paid {x402.total} USDC for job #{x402.jobId} (gas-free) — split {x402.authorPct}% / {100 - (x402.authorPct ?? 0)}%
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {x402.payments.map((p, i) => (
                    <li key={i} className="text-zinc-300">
                      <span className="capitalize text-zinc-100">{p.role}</span> ← {p.amount} USDC → <span className="font-mono">{short(p.to)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-zinc-500">Gateway balances (available · pending USDC)</span>
                    <button onClick={refreshBals} className="text-xs text-indigo-400 hover:underline">refresh</button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <BalCard label="Payer (you)" addr={x402.agent} bals={bals} />
                    <BalCard label="Author" addr={x402.author} bals={bals} />
                    <BalCard label="Auditor" addr={x402.auditor} bals={bals} />
                  </div>
                </div>
                {x402.verifiedLink && (
                  <p className="mt-3 text-zinc-300">Verified link: <span className="font-mono text-xs text-fuchsia-300">{x402.verifiedLink}</span></p>
                )}
              </div>
            )}
            </div>
          )}
        </main>

        {/* RIGHT — live sidebar */}
        <aside className="lg:col-span-1">
          <div className="flex flex-col gap-5 lg:sticky lg:top-6">
            {/* live balances */}
            <div className={card}>
              <div className="mb-3 flex items-center justify-between">
                <span className={label}>Live · balances</span>
                <button onClick={refreshAll} className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs text-white hover:bg-zinc-600">Refresh</button>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Stat k="Your USDC">{fmt(usdcBal.data as bigint)}</Stat>
                <Stat k="Gateway">{gwBal ?? "…"}</Stat>
                <Stat k="Allowance">{fmt(allowance.data as bigint)}</Stat>
                <Stat k="Escrow holds">{fmt(escrowBal.data as bigint)}</Stat>
                <Stat k="Active job">#{jobId || "—"}</Stat>
                <Stat k="Next id">{Number(nextJobId.data ?? 1n)}</Stat>
              </div>
              {isConnected && (
                <p className="mt-3 text-xs text-zinc-500">
                  You:{" "}
                  <a className="text-indigo-400 hover:underline" href={explorerAddress(address!)} target="_blank" rel="noreferrer">{short(address)}</a>
                </p>
              )}
            </div>

            {/* wallets: on-chain USDC + Gateway balance */}
            <div className={card}>
              <div className="mb-3 flex items-center justify-between">
                <span className={label}>Wallets · wallet · gateway</span>
                <button onClick={() => { refetchAll(); fetchGwBal(); fetchAgent(); }} className="text-xs text-indigo-400 hover:underline">refresh</button>
              </div>
              <div className="flex flex-col gap-2 text-sm">
                <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Connected (you) {isConnected ? short(address) : "—"}</div>
                  <div className="mt-0.5">
                    <span className="text-zinc-100">{fmt(usdcBal.data as bigint)}</span> wallet · <span className="text-zinc-100">{gwBal ?? "…"}</span> gw
                    {gwPending && Number(gwPending) > 0 ? <span className="text-amber-300"> (+{gwPending} pending)</span> : null}
                  </div>
                </div>
                <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Agent {agent?.address ? short(agent.address) : "—"}</div>
                  <div className="mt-0.5">
                    <span className="text-zinc-100">{agent?.walletUsdc ?? "…"}</span> wallet · <span className="text-zinc-100">{agent?.gatewayAvailable ?? "…"}</span> gw
                    {agent?.gatewayPending && Number(agent.gatewayPending) > 0 ? <span className="text-amber-300"> (+{agent.gatewayPending} pending)</span> : null}
                  </div>
                </div>
              </div>
            </div>

            {/* jobs progress */}
            <div className={card}>
              <p className="mb-3 text-sm font-medium text-zinc-300">Jobs <span className="text-zinc-500">({jobs.length})</span></p>
              <ul className="flex flex-col gap-2 text-sm">
                {jobs.length === 0 && <li className="text-zinc-600">no jobs yet</li>}
                {jobs.map((j) => (
                  <li key={j.id}>
                    <button
                      onClick={() => setPayJobId(String(j.id))}
                      className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-left transition hover:border-zinc-600"
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">#{j.id}</span>
                        <Badge label={STATUS_LABELS[j.status] ?? "Unknown"} />
                      </span>
                      <span className="text-xs text-zinc-500">fee {fmt(j.fee)} · bond {fmt(j.bond)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-zinc-600">tap a job to set it as the x402 pay target</p>
            </div>

            {/* activity */}
            <div className={card}>
              <p className="mb-2 text-sm font-medium text-zinc-300">Activity</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {log.length === 0 && <li className="text-zinc-600">no txs yet</li>}
                {log.map((l, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className={l.ok ? "text-emerald-400" : "text-rose-400"}>{l.ok ? "✓" : "✕"}</span>
                    <span className="text-zinc-300">{l.action}</span>
                    <a className="text-indigo-400 hover:underline" href={explorerTx(l.hash)} target="_blank" rel="noreferrer">tx ↗</a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Stat({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{k}</span>
      <span className="font-medium text-zinc-100">{children}</span>
    </div>
  );
}

function BalCard({
  label,
  addr,
  bals,
}: {
  label: string;
  addr?: string;
  bals: Record<string, { available?: string; pending?: string }>;
}) {
  const b = addr ? bals[addr.toLowerCase()] : undefined;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-xs text-zinc-400">{addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—"}</div>
      <div className="mt-1 text-sm">
        <span className="text-zinc-100">{b?.available ?? "…"}</span> · <span className="text-amber-300">{b?.pending ?? "…"}</span>
      </div>
    </div>
  );
}

function Badge({ label }: { label: string }) {
  const map: Record<string, string> = {
    Open: "bg-amber-500/20 text-amber-300",
    Funded: "bg-indigo-500/20 text-indigo-300",
    Settled: "bg-emerald-500/20 text-emerald-300",
    Slashed: "bg-rose-500/20 text-rose-300",
    None: "bg-zinc-700/40 text-zinc-400",
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${map[label] ?? map.None}`}>{label}</span>;
}

export default function ArcEscrowTestPage() {
  return (
    <ArcProviders>
      <EscrowTest />
    </ArcProviders>
  );
}
