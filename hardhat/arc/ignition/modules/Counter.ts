import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Deploys the Counter contract (no constructor args).
export default buildModule("CounterModule", (m) => {
  const counter = m.contract("Counter");

  return { counter };
});
