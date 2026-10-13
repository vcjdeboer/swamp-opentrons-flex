/**
 * `@vcjdeboer/opentrons-flex` — drive an Opentrons Flex robot from swamp.
 *
 * Pure HTTP against the robot's REST API. Every method call is recorded in
 * the swamp data layer — health checks, instrument mounts, runs, commands —
 * giving you a full provenance trail of what the robot did and when.
 *
 * No FFI, no background process. The Flex's session identity is a value
 * (a run id string), not a handle, so it survives between method calls in
 * the data layer.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  host: z.string().describe(
    "Hostname or IP of the robot. Prefer a literal IPv4 address — Deno's " +
      "fetch() has no Happy Eyeballs, so a hostname with a blackholed IPv6 " +
      "route will hang until timeout.",
  ),
  port: z.number().int().positive().default(31950).describe(
    "Robot HTTP port. 31950 is the Opentrons default.",
  ),
  requestTimeoutMs: z.number().int().positive().default(10_000).describe(
    "Per-request timeout in milliseconds.",
  ),
  commandSettleTimeoutMs: z.number().int().positive().default(120_000).describe(
    "How long to wait for a dispatched robot command to reach a terminal " +
      "state. Motion commands can take far longer than one request timeout.",
  ),
  opentronsVersion: z.string().default("3").describe(
    "Value for the opentrons-version header the robot requires.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HealthSchema = z.object({
  reachable: z.boolean(),
  url: z.string(),
  name: z.string().nullable(),
  apiVersion: z.string().nullable(),
  robotModel: z.string().nullable(),
  systemVersion: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
  observedAt: z.string(),
  elapsedMs: z.number(),
});

const MountSchema = z.object({
  mount: z.string(),
  instrumentType: z.string(),
  instrumentName: z.string().nullable(),
  instrumentModel: z.string().nullable(),
  serialNumber: z.string().nullable(),
  ok: z.boolean().nullable(),
});

const InstrumentsSchema = z.object({
  mounts: z.array(MountSchema),
  count: z.number(),
  hasGripper: z.boolean(),
  observedAt: z.string(),
  elapsedMs: z.number(),
});

const LightsSchema = z.object({
  on: z.boolean(),
  observedAt: z.string(),
});

const RunSessionSchema = z.object({
  runId: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

const CommandRecordSchema = z.object({
  runId: z.string(),
  commandType: z.string(),
  params: z.record(z.string(), z.unknown()),
  commandId: z.string(),
  status: z.string(),
  result: z.record(z.string(), z.unknown()),
  elapsedMs: z.number(),
  recordedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Transport — pure fetch(), no swamp dependency
// ---------------------------------------------------------------------------

interface FlexTarget {
  host: string;
  port: number;
  requestTimeoutMs: number;
  commandSettleTimeoutMs: number;
  opentronsVersion: string;
}

function targetFrom(g: GlobalArgs): FlexTarget {
  return {
    host: g.host,
    port: g.port,
    requestTimeoutMs: g.requestTimeoutMs,
    commandSettleTimeoutMs: g.commandSettleTimeoutMs,
    opentronsVersion: g.opentronsVersion,
  };
}

function baseUrl(t: FlexTarget): string {
  return `http://${t.host}:${t.port}`;
}

async function getJson(
  t: FlexTarget,
  path: string,
): Promise<{ body: Record<string, unknown>; elapsedMs: number }> {
  const url = `${baseUrl(t)}${path}`;
  const t0 = performance.now();

  const response = await fetch(url, {
    headers: {
      "opentrons-version": t.opentronsVersion,
      "accept": "application/json",
    },
    signal: AbortSignal.timeout(t.requestTimeoutMs),
  });

  const elapsedMs = performance.now() - t0;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET ${url} returned ${response.status}: ${text.slice(0, 400)}`,
    );
  }
  return { body: JSON.parse(text) as Record<string, unknown>, elapsedMs };
}

async function postJson(
  t: FlexTarget,
  path: string,
  payload: unknown,
): Promise<{ body: Record<string, unknown>; elapsedMs: number }> {
  const url = `${baseUrl(t)}${path}`;
  const t0 = performance.now();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "opentrons-version": t.opentronsVersion,
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(t.requestTimeoutMs),
  });

  const elapsedMs = performance.now() - t0;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST ${url} returned ${response.status}: ${text.slice(0, 400)}. ` +
        `A POST that failed may still have been acted on by the robot.`,
    );
  }
  return { body: JSON.parse(text) as Record<string, unknown>, elapsedMs };
}

const SETTLE_POLL_INTERVAL_MS = 200;

async function executeCommand(
  t: FlexTarget,
  runId: string,
  commandType: string,
  params: Record<string, unknown>,
): Promise<{
  id: string;
  status: string;
  result: Record<string, unknown>;
  elapsedMs: number;
}> {
  const t0 = performance.now();
  const posted = await postJson(t, `/runs/${runId}/commands`, {
    data: { commandType, params, intent: "setup" },
  });
  const cmd = dataOf(posted.body);
  const id = typeof cmd["id"] === "string" ? cmd["id"] : "";
  let status = typeof cmd["status"] === "string" ? cmd["status"] : "unknown";
  let settled = cmd;

  if (id !== "") {
    const deadline = performance.now() + t.commandSettleTimeoutMs;
    while (
      (status === "queued" || status === "running") &&
      performance.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
      const got = await getJson(t, `/runs/${runId}/commands/${id}`);
      settled = dataOf(got.body);
      status = typeof settled["status"] === "string"
        ? settled["status"]
        : "unknown";
    }
  }

  if (status === "failed") {
    const error = settled["error"] as Record<string, unknown> | undefined;
    throw new Error(
      `command ${commandType} failed (run ${runId}, command ${id}): ${
        error ? JSON.stringify(error).slice(0, 400) : "no error detail"
      }`,
    );
  }

  if (status === "queued" || status === "running") {
    throw new Error(
      `command ${commandType} did not settle within ${
        t.commandSettleTimeoutMs
      }ms (run ${runId}, command ${id}, last status '${status}'). ` +
        `The robot may still be executing it — do not retry blindly.`,
    );
  }

  return {
    id,
    status,
    result: (settled["result"] ?? {}) as Record<string, unknown>,
    elapsedMs: performance.now() - t0,
  };
}

function dataOf(body: Record<string, unknown>): Record<string, unknown> {
  const d = body["data"];
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new Error(
      `response has no 'data' object: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return d as Record<string, unknown>;
}

function str(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

// ---------------------------------------------------------------------------
// MethodContext type (provided by swamp at runtime)
// ---------------------------------------------------------------------------

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warning: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** Model definition for driving an Opentrons Flex robot. */
export const model = {
  type: "@vcjdeboer/opentrons-flex",
  version: "2026.10.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "health": {
      description: "Whether the robot answers, and what it says it is",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "instruments": {
      description: "Pipettes and gripper currently mounted",
      schema: InstrumentsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "lights": {
      description: "Current state of the robot's deck lights",
      schema: LightsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "run_session": {
      description:
        "An open run on the robot — the session identity. Every command " +
        "needs one. The robot limits open runs, so stranded ids are not free.",
      schema: RunSessionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "command": {
      description:
        "One command the robot accepted and settled: what was asked, what " +
        "it answered, and how long it took.",
      schema: CommandRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    health: {
      description:
        "GET /health. Records whether the robot is reachable and what it " +
        "reports — name, API version, model, system version.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { body, elapsedMs } = await getJson(target, "/health");

        const health = {
          reachable: true,
          url: baseUrl(target),
          name: str(body, "name"),
          apiVersion: str(body, "api_version"),
          robotModel: str(body, "robot_model"),
          systemVersion: str(body, "system_version"),
          raw: body,
          observedAt: new Date().toISOString(),
          elapsedMs,
        };

        ctx.logger.info(
          `robot '${health.name ?? "unknown"}' at ${health.url}` +
            ` (API ${health.apiVersion ?? "?"}, model ${
              health.robotModel ?? "?"
            })`,
          { elapsedMs: Math.round(elapsedMs) },
        );

        const handle = await ctx.writeResource("health", "health-current", health);
        return { dataHandles: [handle] };
      },
    },

    instruments: {
      description:
        "GET /instruments. Records which pipettes and gripper are mounted, " +
        "by mount, model and serial number.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { body, elapsedMs } = await getJson(
          targetFrom(ctx.globalArgs),
          "/instruments",
        );

        const raw = Array.isArray(body.data)
          ? body.data
          : (Array.isArray(body) ? body : []);

        const mounts = (raw as Array<Record<string, unknown>>).map((d) => ({
          mount: str(d, "mount") ?? "unknown",
          instrumentType: str(d, "instrumentType") ?? "unknown",
          instrumentName: str(d, "instrumentName"),
          instrumentModel: str(d, "instrumentModel"),
          serialNumber: str(d, "serialNumber"),
          ok: typeof d.ok === "boolean" ? d.ok : null,
        }));

        const hasGripper = mounts.some((m) =>
          m.instrumentType === "gripper" || m.mount === "extension"
        );

        ctx.logger.info(
          `${mounts.length} instrument(s) mounted${
            hasGripper ? ", including a gripper" : ""
          }`,
          {
            mounts: mounts.map((m) => `${m.mount}=${m.instrumentName ?? "?"}`)
              .join(", "),
          },
        );

        const handle = await ctx.writeResource("instruments", "mounted", {
          mounts,
          count: mounts.length,
          hasGripper,
          observedAt: new Date().toISOString(),
          elapsedMs,
        });
        return { dataHandles: [handle] };
      },
    },

    lights: {
      description:
        "GET or set the robot's deck lights. Without arguments, reads the " +
        "current state. With on=true/false, sets the lights.",
      arguments: z.object({
        on: z.boolean().optional().describe(
          "Set the lights on (true) or off (false). Omit to just read.",
        ),
      }),
      execute: async (
        args: { on?: boolean },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);

        let lightsOn: boolean;
        if (args.on !== undefined) {
          const { body } = await postJson(target, "/robot/lights", {
            on: args.on,
          });
          lightsOn = typeof body.on === "boolean" ? body.on : args.on;
          ctx.logger.info(`lights ${lightsOn ? "on" : "off"}`);
        } else {
          const { body } = await getJson(target, "/robot/lights");
          lightsOn = typeof body.on === "boolean" ? body.on : false;
          ctx.logger.info(`lights are ${lightsOn ? "on" : "off"}`);
        }

        const handle = await ctx.writeResource("lights", "lights-current", {
          on: lightsOn,
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    open_run: {
      description:
        "POST /runs. Opens a run session on the robot. Returns the run id " +
        "needed by home and other commands.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { body } = await postJson(target, "/runs", {
          data: {},
        });
        const run = dataOf(body);
        const runId = str(run, "id") ?? "";
        const session = {
          runId,
          url: `${baseUrl(target)}/runs/${runId}`,
          createdAt: new Date().toISOString(),
        };
        ctx.logger.info(`run ${runId} opened`);
        const handle = await ctx.writeResource("run_session", runId, session);
        return { dataHandles: [handle] };
      },
    },

    close_run: {
      description: "Stop a run. Safe to call on one already stopped.",
      arguments: z.object({
        runId: z.string().describe("The run id to close."),
      }),
      execute: async (
        args: { runId: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        await postJson(target, `/runs/${args.runId}/actions`, {
          data: { actionType: "stop" },
        });
        ctx.logger.info(`run ${args.runId} closed`);
        const handle = await ctx.writeResource("run_session", args.runId, {
          runId: args.runId,
          url: `${baseUrl(target)}/runs/${args.runId}`,
          createdAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    home: {
      description:
        "Home the robot's gantry. Requires an open run (use open_run first).",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
      }),
      execute: async (
        args: { runId: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "home",
          {},
        );
        ctx.logger.info(`home completed (${Math.round(elapsedMs)}ms)`);
        const handle = await ctx.writeResource("command", `home-${id}`, {
          runId: args.runId,
          commandType: "home",
          params: {},
          commandId: id,
          status,
          result,
          elapsedMs,
          recordedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    load_pipette: {
      description:
        "Load a pipette on a mount. Returns the pipetteId needed by " +
        "pick_up_tip, aspirate, and dispense.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        pipetteName: z.string().describe(
          "Engine pipette name, e.g. p50_multi_flex, p1000_single_flex.",
        ),
        mount: z.enum(["left", "right"]).describe("Which mount to load on."),
      }),
      execute: async (
        args: { runId: string; pipetteName: string; mount: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "loadPipette",
          { pipetteName: args.pipetteName, mount: args.mount },
        );
        const pipetteId = typeof result.pipetteId === "string"
          ? result.pipetteId
          : id;
        ctx.logger.info(
          `loaded ${args.pipetteName} on ${args.mount} → ${pipetteId}`,
        );
        const handle = await ctx.writeResource(
          "command",
          `loadPipette-${id}`,
          {
            runId: args.runId,
            commandType: "loadPipette",
            params: { pipetteName: args.pipetteName, mount: args.mount },
            commandId: id,
            status,
            result,
            elapsedMs,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    load_labware: {
      description:
        "Load labware into a deck slot. Returns the labwareId needed by " +
        "pick_up_tip, aspirate, and dispense.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        labwareDefinitionUri: z.string().describe(
          "Opentrons labware URI, e.g. opentrons/nest_12_reservoir_15ml/1, " +
          "opentrons/nest_96_wellplate_200ul_flat/2, " +
          "opentrons/opentrons_flex_96_tiprack_50ul/1.",
        ),
        slot: z.string().describe("Deck slot, e.g. C1, D2, A1."),
      }),
      execute: async (
        args: { runId: string; labwareDefinitionUri: string; slot: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "loadLabware",
          {
            loadName: args.labwareDefinitionUri.split("/")[1] ?? args.labwareDefinitionUri,
            namespace: args.labwareDefinitionUri.split("/")[0] ?? "opentrons",
            version: parseInt(args.labwareDefinitionUri.split("/")[2] ?? "1"),
            location: { slotName: args.slot },
          },
        );
        const labwareId = typeof result.labwareId === "string"
          ? result.labwareId
          : id;
        ctx.logger.info(
          `loaded ${args.labwareDefinitionUri} in slot ${args.slot} → ${labwareId}`,
        );
        const handle = await ctx.writeResource(
          "command",
          `loadLabware-${id}`,
          {
            runId: args.runId,
            commandType: "loadLabware",
            params: {
              labwareDefinitionUri: args.labwareDefinitionUri,
              slot: args.slot,
            },
            commandId: id,
            status,
            result,
            elapsedMs,
            recordedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    pick_up_tip: {
      description: "Pick up tips from a tip rack.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        pipetteId: z.string().describe("The pipetteId from load_pipette."),
        labwareId: z.string().describe("The labwareId of the tip rack."),
        well: z.string().default("A1").describe("Well to pick up from, e.g. A1."),
      }),
      execute: async (
        args: { runId: string; pipetteId: string; labwareId: string; well: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "pickUpTip",
          {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            wellName: args.well,
          },
        );
        ctx.logger.info(
          `picked up tip from ${args.labwareId} well ${args.well}`,
        );
        const handle = await ctx.writeResource("command", `pickUpTip-${id}`, {
          runId: args.runId,
          commandType: "pickUpTip",
          params: {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            well: args.well,
          },
          commandId: id,
          status,
          result,
          elapsedMs,
          recordedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    aspirate: {
      description: "Aspirate liquid from a well.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        pipetteId: z.string().describe("The pipetteId from load_pipette."),
        labwareId: z.string().describe("The labwareId of the source labware."),
        well: z.string().default("A1").describe("Well to aspirate from."),
        volume: z.number().positive().describe("Volume in µL."),
        flowRate: z.number().positive().default(46).describe(
          "Flow rate in µL/s. Default 46 matches p50 flex defaults.",
        ),
      }),
      execute: async (
        args: {
          runId: string;
          pipetteId: string;
          labwareId: string;
          well: string;
          volume: number;
          flowRate: number;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "aspirate",
          {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            wellName: args.well,
            wellLocation: { origin: "bottom", offset: { x: 0, y: 0, z: 1 } },
            volume: args.volume,
            flowRate: args.flowRate,
          },
        );
        ctx.logger.info(
          `aspirated ${args.volume} µL from ${args.labwareId} well ${args.well}`,
        );
        const handle = await ctx.writeResource("command", `aspirate-${id}`, {
          runId: args.runId,
          commandType: "aspirate",
          params: {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            well: args.well,
            volume: args.volume,
            flowRate: args.flowRate,
          },
          commandId: id,
          status,
          result,
          elapsedMs,
          recordedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    dispense: {
      description: "Dispense liquid into a well.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        pipetteId: z.string().describe("The pipetteId from load_pipette."),
        labwareId: z.string().describe("The labwareId of the destination labware."),
        well: z.string().default("A1").describe("Well to dispense into."),
        volume: z.number().positive().describe("Volume in µL."),
        flowRate: z.number().positive().default(46).describe(
          "Flow rate in µL/s.",
        ),
      }),
      execute: async (
        args: {
          runId: string;
          pipetteId: string;
          labwareId: string;
          well: string;
          volume: number;
          flowRate: number;
        },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "dispense",
          {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            wellName: args.well,
            wellLocation: { origin: "bottom", offset: { x: 0, y: 0, z: 1 } },
            volume: args.volume,
            flowRate: args.flowRate,
          },
        );
        ctx.logger.info(
          `dispensed ${args.volume} µL into ${args.labwareId} well ${args.well}`,
        );
        const handle = await ctx.writeResource("command", `dispense-${id}`, {
          runId: args.runId,
          commandType: "dispense",
          params: {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            well: args.well,
            volume: args.volume,
            flowRate: args.flowRate,
          },
          commandId: id,
          status,
          result,
          elapsedMs,
          recordedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    drop_tip: {
      description: "Return tips to a loaded tip rack.",
      arguments: z.object({
        runId: z.string().describe("The run id from open_run."),
        pipetteId: z.string().describe("The pipetteId from load_pipette."),
        labwareId: z.string().describe("The labwareId of the tip rack."),
        well: z.string().default("A1").describe("Well to drop tips into."),
      }),
      execute: async (
        args: { runId: string; pipetteId: string; labwareId: string; well: string },
        ctx: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const target = targetFrom(ctx.globalArgs);
        const { id, status, result, elapsedMs } = await executeCommand(
          target,
          args.runId,
          "dropTip",
          {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            wellName: args.well,
          },
        );
        ctx.logger.info(
          `dropped tip into ${args.labwareId} well ${args.well}`,
        );
        const handle = await ctx.writeResource("command", `dropTip-${id}`, {
          runId: args.runId,
          commandType: "dropTip",
          params: {
            pipetteId: args.pipetteId,
            labwareId: args.labwareId,
            well: args.well,
          },
          commandId: id,
          status,
          result,
          elapsedMs,
          recordedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
