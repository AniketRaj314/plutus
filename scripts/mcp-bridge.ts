// Local stdio MCP server that bridges to the real Plutus MCP endpoint over
// authenticated HTTP. Exists because Claude Desktop's claude_desktop_config.json
// only supports launching local stdio servers (command/args), and its
// in-app "custom connector" UI only offers OAuth for remote servers — Plutus
// uses a simple bearer token instead. This bridge lets Claude Desktop spawn a
// local process (no auth needed for that, it's just a subprocess) which then
// authenticates to the real server on Claude Desktop's behalf.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

async function main() {
  const remoteUrl = process.env.PLUTUS_MCP_URL;
  const token = process.env.PLUTUS_MCP_TOKEN;

  if (!remoteUrl || !token) {
    console.error("PLUTUS_MCP_URL and PLUTUS_MCP_TOKEN must be set in the bridge's env");
    process.exit(1);
  }

  const client = new Client({ name: "plutus-bridge-client", version: "1.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(new URL(remoteUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(clientTransport);

  const server = new Server({ name: "plutus", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return client.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return client.callTool(request.params);
  });

  const serverTransport = new StdioServerTransport();
  await server.connect(serverTransport);
}

main().catch((err) => {
  console.error("[mcp-bridge] fatal error:", err);
  process.exit(1);
});
