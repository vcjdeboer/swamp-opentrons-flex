/**
 * A minimal Opentrons Flex simulator for testing `@vcjdeboer/opentrons-flex`
 * without a physical robot.
 *
 * Responds to the same HTTP endpoints the real robot serves: /health,
 * /instruments, /robot/lights, /runs, and /runs/:id/commands. Commands
 * succeed immediately — no motion, no physics.
 *
 * Usage:
 *   deno run --allow-net sim/fake_flex.ts [--port 31950]
 *
 * Then point a swamp model at localhost:
 *   swamp model create @vcjdeboer/opentrons-flex sim-flex --set host=localhost
 *   swamp model @vcjdeboer/opentrons-flex method run health sim-flex
 *
 * @module
 */

const HEALTH = {
  name: "flex-simulator",
  api_version: "8.2.0",
  fw_version: "v1.2.3",
  system_version: "v8.2.0",
  robot_model: "OT-3 Standard",
  robot_serial: "SIM0000000000001",
  logs: [],
  maximum_protocol_api_version: [2, 21],
  minimum_protocol_api_version: [2, 0],
};

const INSTRUMENTS = {
  data: [
    {
      mount: "left",
      instrumentType: "pipette",
      instrumentName: "p1000_single_flex",
      instrumentModel: "p1000_single_v3.5",
      serialNumber: "P1KSV35-SIM-L",
      ok: true,
    },
    {
      mount: "right",
      instrumentType: "pipette",
      instrumentName: "p50_multi_flex",
      instrumentModel: "p50_multi_v3.5",
      serialNumber: "P50MV35-SIM-R",
      ok: true,
    },
    {
      mount: "extension",
      instrumentType: "gripper",
      instrumentName: "gripper",
      instrumentModel: "gripperV1.3",
      serialNumber: "GRPV13-SIM",
      ok: true,
    },
  ],
  meta: { cursor: 0, totalLength: 3 },
};

let lightsOn = false;
const runs = new Map<string, Record<string, unknown>[]>();
let runSeq = 0;
let cmdSeq = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // GET /health
  if (method === "GET" && path === "/health") {
    return json(HEALTH);
  }

  // GET /instruments
  if (method === "GET" && path === "/instruments") {
    return json(INSTRUMENTS);
  }

  // GET/POST /robot/lights
  if (path === "/robot/lights") {
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      lightsOn = body.on === true;
    }
    return json({ on: lightsOn });
  }

  // POST /runs — open a run
  if (method === "POST" && path === "/runs") {
    const id = `sim-run-${++runSeq}`;
    runs.set(id, []);
    return json({
      data: {
        id,
        status: "idle",
        createdAt: new Date().toISOString(),
      },
    }, 201);
  }

  // POST /runs/:id/actions — stop a run
  const actionsMatch = path.match(/^\/runs\/([^/]+)\/actions$/);
  if (method === "POST" && actionsMatch) {
    return json({
      data: { actionType: "stop", id: actionsMatch[1] },
    });
  }

  // POST /runs/:id/commands — execute a command
  const cmdMatch = path.match(/^\/runs\/([^/]+)\/commands$/);
  if (method === "POST" && cmdMatch) {
    const body = await req.json() as Record<string, unknown>;
    const cmdData = body.data as Record<string, unknown>;
    const commandType = cmdData?.commandType as string;
    const params = (cmdData?.params ?? {}) as Record<string, unknown>;
    const id = `sim-cmd-${++cmdSeq}`;

    const result: Record<string, unknown> =
      commandType === "loadLabware" ? { labwareId: `labware-${id}` } :
      commandType === "loadPipette" ? { pipetteId: `pipette-${id}` } :
      commandType === "loadModule" ? { moduleId: `module-${id}` } :
      commandType === "moveToWell" ? { position: { x: 0, y: 0, z: 0 } } :
      {};

    const record = {
      id,
      commandType,
      params,
      status: "succeeded",
      result,
      createdAt: new Date().toISOString(),
    };

    runs.get(cmdMatch[1])?.push(record);
    return json({ data: record }, 201);
  }

  // GET /runs/:runId/commands/:cmdId — poll command status
  const pollMatch = path.match(/^\/runs\/([^/]+)\/commands\/([^/]+)$/);
  if (method === "GET" && pollMatch) {
    const cmds = runs.get(pollMatch[1]) ?? [];
    const cmd = cmds.find((c) => c.id === pollMatch[2]);
    if (cmd) return json({ data: cmd });
    return json({ errors: [{ detail: "command not found" }] }, 404);
  }

  return json({ errors: [{ detail: `not found: ${method} ${path}` }] }, 404);
}

// --- CLI entry point ---
if (import.meta.main) {
  const portArg = Deno.args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(Deno.args[portArg + 1]) : 31950;

  Deno.serve({ port, hostname: "0.0.0.0" }, handler);
  console.log(`Flex simulator listening on http://localhost:${port}`);
}
