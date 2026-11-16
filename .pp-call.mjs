// Temporary stdio MCP client for premiere-live (session helper; not committed)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [,, tool, argsJson] = process.argv;
const t = new StdioClientTransport({ command: 'node', args: ['src/mcp-servers/premiere-server.js'], cwd: process.cwd(), stderr: 'ignore' });
const c = new Client({ name: 'pp-cli', version: '1.0.0' });
await c.connect(t);
await new Promise(r => setTimeout(r, 1500));
try {
  if (tool === '--list') {
    const { tools } = await c.listTools();
    for (const x of tools) console.log(x.name + ' :: ' + (x.description||'').slice(0,140).replace(/\n/g,' '));
  } else if (tool === '--schema') {
    const { tools } = await c.listTools();
    const x = tools.find(z => z.name === argsJson); console.log(JSON.stringify(x?.inputSchema));
  } else {
    const r = await c.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} }, undefined, { timeout: 600000 });
    for (const p of r.content||[]) console.log(p.type==='text'? p.text : JSON.stringify(p).slice(0,500));
    if (r.isError) process.exitCode = 2;
  }
} finally { await c.close(); }
