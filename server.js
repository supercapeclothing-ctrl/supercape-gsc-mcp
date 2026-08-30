import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.GSC_SITE_URL || "sc-domain:supercape.in";
const SECRET_FILE_PATH =
  process.env.GOOGLE_SERVICE_ACCOUNT_FILE ||
  "/etc/secrets/google-service-account.json";

function normalizePrivateKey(raw = "") {
  return String(raw).replace(/\\n/g, "\n").trim();
}

function loadCredentials() {
  if (fs.existsSync(SECRET_FILE_PATH)) {
    const raw = fs.readFileSync(SECRET_FILE_PATH, "utf8");
    const obj = JSON.parse(raw);

    if (!obj.client_email || !obj.private_key) {
      throw new Error(
        `Secret file ${SECRET_FILE_PATH} is missing client_email/private_key`
      );
    }

    return {
      client_email: obj.client_email.trim(),
      private_key: normalizePrivateKey(obj.private_key),
      source: "secret_file",
      project_id: obj.project_id || null,
    };
  }

  const client_email = (process.env.GOOGLE_CLIENT_EMAIL || "").trim();
  const private_key = normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || "");

  if (!client_email || !private_key) {
    throw new Error(
      `Google credentials not found. Expected secret file at ${SECRET_FILE_PATH}`
    );
  }

  return {
    client_email,
    private_key,
    source: "separate_env",
    project_id: null,
  };
}

function validateCredentials(creds) {
  if (
    !creds.private_key.includes("-----BEGIN PRIVATE KEY-----") ||
    !creds.private_key.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error(
      "Google private key is malformed: PEM BEGIN/END markers are missing."
    );
  }
  return creds;
}

function getAuth() {
  const creds = validateCredentials(loadCredentials());
  return {
    creds,
    auth: new google.auth.GoogleAuth({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    }),
  };
}

function getSearchConsole() {
  const { auth } = getAuth();
  return google.searchconsole({ version: "v1", auth });
}

function jsonText(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function safeError(error, stage) {
  const response = error?.response;
  const data = response?.data;

  return {
    ok: false,
    stage,
    name: error?.name || null,
    message: error?.message || "Unknown error",
    httpStatus: response?.status || error?.code || null,
    googleError: data?.error || data || null,
  };
}

async function safeTool(stage, fn) {
  try {
    const result = await fn();
    return jsonText({ ok: true, stage, ...result });
  } catch (error) {
    console.error(`[${stage}]`, error);
    return jsonText(safeError(error, stage));
  }
}

function makeServer() {
  const server = new McpServer({
    name: "supercape-gsc-mcp",
    version: "2.3.0",
  });

  server.tool(
    "gsc_diagnose",
    "Diagnose Google Search Console authentication and API access without exposing secrets.",
    {},
    async () =>
      safeTool("diagnose", async () => {
        const { creds, auth } = getAuth();

        // Forces token acquisition, separating auth failures from API failures.
        const client = await auth.getClient();
        const token = await client.getAccessToken();

        const gsc = google.searchconsole({ version: "v1", auth });
        const sites = await gsc.sites.list();

        return {
          credentialSource: creds.source,
          projectId: creds.project_id,
          clientEmail: creds.client_email,
          accessTokenObtained: Boolean(token?.token),
          siteCount: sites.data.siteEntry?.length || 0,
          sites: sites.data.siteEntry || [],
        };
      })
  );

  server.tool(
    "gsc_list_sites",
    "List Google Search Console properties accessible to the configured service account.",
    {},
    async () =>
      safeTool("list_sites", async () => {
        const gsc = getSearchConsole();
        const response = await gsc.sites.list();
        return {
          siteCount: response.data.siteEntry?.length || 0,
          sites: response.data.siteEntry || [],
        };
      })
  );

  server.tool(
    "gsc_search_analytics",
    "Query Google Search Console clicks, impressions, CTR and average position.",
    {
      startDate: z.string().describe("YYYY-MM-DD"),
      endDate: z.string().describe("YYYY-MM-DD"),
      dimensions: z
        .array(
          z.enum([
            "query",
            "page",
            "country",
            "device",
            "date",
            "searchAppearance",
          ])
        )
        .default(["query"]),
      rowLimit: z.number().int().min(1).max(25000).default(100),
      siteUrl: z.string().optional(),
    },
    async ({ startDate, endDate, dimensions, rowLimit, siteUrl }) =>
      safeTool("search_analytics", async () => {
        const gsc = getSearchConsole();
        const response = await gsc.searchanalytics.query({
          siteUrl: siteUrl || SITE_URL,
          requestBody: { startDate, endDate, dimensions, rowLimit },
        });
        return { siteUrl: siteUrl || SITE_URL, data: response.data };
      })
  );

  server.tool(
    "gsc_top_opportunities",
    "Find high-impression queries ranking outside the top positions for SEO prioritization.",
    {
      startDate: z.string().describe("YYYY-MM-DD"),
      endDate: z.string().describe("YYYY-MM-DD"),
      minImpressions: z.number().min(1).default(20),
      minPosition: z.number().min(1).default(4),
      maxPosition: z.number().min(1).default(30),
      limit: z.number().int().min(1).max(1000).default(50),
    },
    async ({
      startDate,
      endDate,
      minImpressions,
      minPosition,
      maxPosition,
      limit,
    }) =>
      safeTool("top_opportunities", async () => {
        const gsc = getSearchConsole();
        const response = await gsc.searchanalytics.query({
          siteUrl: SITE_URL,
          requestBody: {
            startDate,
            endDate,
            dimensions: ["query", "page"],
            rowLimit: 25000,
          },
        });

        const rows = (response.data.rows || [])
          .filter(
            (row) =>
              (row.impressions || 0) >= minImpressions &&
              (row.position || 0) >= minPosition &&
              (row.position || 0) <= maxPosition
          )
          .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
          .slice(0, limit);

        return {
          siteUrl: SITE_URL,
          count: rows.length,
          rows,
        };
      })
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "SuperCape Google Search Console MCP",
    status: "ok",
    version: "2.3.0",
    mcp: "/mcp",
    site: SITE_URL,
  });
});

app.get("/health", async (_req, res) => {
  try {
    const creds = validateCredentials(loadCredentials());
    const { auth } = getAuth();
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    res.json({
      ok: true,
      version: "2.3.0",
      credentialSource: creds.source,
      secretFileFound: fs.existsSync(SECRET_FILE_PATH),
      clientEmail: creds.client_email,
      projectId: creds.project_id,
      privateKeyLooksValid: true,
      accessTokenObtained: Boolean(token?.token),
      site: SITE_URL,
    });
  } catch (error) {
    res.status(500).json(safeError(error, "health"));
  }
});

const transports = {};

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && transports[sessionId]) {
      return await transports[sessionId].handleRequest(req, res, req.body);
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      const server = makeServer();
      await server.connect(transport);
      return await transport.handleRequest(req, res, req.body);
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing/invalid MCP session" },
      id: null,
    });
  } catch (error) {
    console.error("[mcp_transport]", error);
    if (!res.headersSent) res.status(500).json(safeError(error, "mcp_transport"));
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid MCP session");
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid MCP session");
  }
  await transports[sessionId].handleRequest(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SuperCape GSC MCP v2.3.0 listening on port ${PORT}`);
});
