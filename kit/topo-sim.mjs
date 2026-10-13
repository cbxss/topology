// Stable public entry point. Figure authors use specs; engine maintainers use sim/.
import { createSim } from "./sim/core.mjs";
import { SIM_DEFAULTS, SERVICE_MS, DETECT, rngOf, isLog, groupOf, routeOf, hashOf } from "./sim/common.mjs";
import { targetOf, normalizeScenario } from "./sim/scenario.mjs";
import { formatRate, formatCount, formatMs, statsOf, summaryOf } from "./sim/reporting.mjs";

export { createSim, SIM_DEFAULTS, SERVICE_MS, DETECT, rngOf, isLog, groupOf, routeOf, hashOf, targetOf, normalizeScenario, formatRate, formatCount, formatMs, statsOf, summaryOf };
