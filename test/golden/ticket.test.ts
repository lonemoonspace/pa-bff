// 金标准：TicketPolicy.statuses / evaluate，逐字符对齐 Kotlin 端的输出。
import ticketPolicyEvaluate from "../../../contracts/golden/ticket-policy.evaluate.json";
import ticketPolicyStatuses from "../../../contracts/golden/ticket-policy.statuses.json";
import { DEFAULT_SETTINGS } from "../../src/contract/settings";
import { evaluate, statuses } from "../../src/domain/ticket";
import { parseIso } from "../../src/util/time";
import { runGolden } from "./harness";

interface TicketStatusesInput {
  transitPassUntil: string;
  parkingPassUntil: string;
  now: string;
}

interface TicketEvaluateInput extends TicketStatusesInput {
  previousKeys: string[];
}

function parseNow(now: string): Date {
  const parsed = parseIso(now);
  if (!parsed) throw new Error(`无法解析 now: ${now}`);
  return parsed;
}

runGolden(ticketPolicyStatuses, (input) => {
  const { transitPassUntil, parkingPassUntil, now } = input as TicketStatusesInput;
  const settings = { ...DEFAULT_SETTINGS, transitPassUntil, parkingPassUntil };
  return statuses(settings, parseNow(now));
});

runGolden(ticketPolicyEvaluate, (input) => {
  const { transitPassUntil, parkingPassUntil, now, previousKeys } = input as TicketEvaluateInput;
  const settings = { ...DEFAULT_SETTINGS, transitPassUntil, parkingPassUntil };
  return evaluate(settings, parseNow(now), { keys: previousKeys });
});
