import express from "express";
import crypto from "node:crypto";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.GSC_SITE_URL || "sc-domain:supercape.in";

function credentials() {
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!client_email || !private_key) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY");
  }
  return { client_email, private_key };
}

function searchConsole() {
  const auth = new google.auth.GoogleAuth({
    credentials: credentials(),
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"]
  });
  return google.searchconsole({ version: "v1", auth });
}

function jsonText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function makeServer() {
  const server = new McpServer({
    name: "supercape-gsc-mcp",
    version: "2.0.0"
  });

  server.tool(
    "gsc_list_sites",
    "List Google Search Console properties accessible to the configured service account.",
    {},
    async () => {
      const gsc = searchConsole();
      const r = await gsc.sites.list();
      return jsonText(r.data);
    }
  );

  server.tool(
    "gsc_search_analytics",
    "Query Search Console clicks, impressions, CTR and average position.",
    {
      startDate: z.string().describe("YYYY-MM-DD"),
      endDate: z.string().describe("YYYY-MM-DD"),
      dimensions: z.array(z.enum(["query","page","country","device","date","searchAppearance"])).default(["query"]),
      rowLimit: z.number().int().min(1).max(25000).default(100),
      siteUrl: z.string().optional().describe("Defaults to GSC_SITE_URL")
    },
    async ({ startDate, endDate, dimensions, rowLimit, siteUrl }) => {
      const gsc = searchConsole();
      const r = await gsc.searchanalytics.query({
        siteUrl: siteUrl || SITE_URL,
        requestBody: { startDate, endDate, dimensions, rowLimit }
      });
      return jsonText(r.data);
    }
  );

  server.tool(
    "gsc_top_opportunities",
    "Find high-impression queries that are not yet ranking in the top positions, useful for SEO prioritization.",
    {
      startDate: z.string().describe("YYYY-MM-DD"),
      endDate: z.string().describe("YYYY-MM-DD"),
      minImpressions: z.number().min(1).default(20),
      minPosition: z.number().min(1).default(4),
      maxPosition: z.number().min(1).default(30),
      limit: z.number().int().min(1).max(1000).default(50)
    },
    async ({ startDate, endDate, minImpressions, minPosition, maxPosition, limit }) => {
      const gsc = searchConsole();
      const r = await gsc.searchanalytics.query({
        siteUrl: SITE_URL,
        requestBody: {
          startDate, endDate,
          dimensions: ["query", "page"],
          rowLimit: 25000
        }
      });
      const rows = (r.data.rows || [])
        .filter(x => (x.impressions || 0) >= minImpressions &&
                     (x.position || 0) >= minPosition &&
                     (x.position || 0) <= maxPosition)
        .sort((a,b) => (b.impressions || 0) - (a.impressions || 0))
        .slice(0, limit);
      return jsonText({ siteUrl: SITE_URL, count: rows.length, rows });
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({
  service: "SuperCape Google Search Console MCP",
  status: "ok",
  mcp: "/mcp",
  site: SITE_URL
}));

app.get("/health", (_req, res) => res.json({ ok: true }));

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
        onsessioninitialized: (id) => { transports[id] = transport; }
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
      id: null
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/mcp", async (req, res) => {
  const id = req.headers["mcp-session-id"];
  if (!id || !transports[id]) return res.status(400).send("Invalid MCP session");
  await transports[id].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const id = req.headers["mcp-session-id"];
  if (!id || !transports[id]) return res.status(400).send("Invalid MCP session");
  await transports[id].handleRequest(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SuperCape GSC MCP listening on port ${PORT}`);
});
