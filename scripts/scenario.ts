// Build the scenario repo from src/scenario.ts and print its path.
import { buildScenario } from "../src/scenario.ts";

const { root } = await buildScenario(process.argv[2]);
process.stdout.write(root + "\n");
