import { awaitsReadApproval, type ReadApprovalRequired } from "../../src/mcp/tools.js";

// The result of a call or a test that ran. Only a read sent with POST waits for the person's approval, so for any other
// operation this is the runtime's result.
export function ran<Result extends object>(result: Result | ReadApprovalRequired): Result {
  if (awaitsReadApproval(result)) throw new Error(`The read waits for the person's approval: ${result.operationId}`);
  return result;
}
