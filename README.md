# SuperCape Google Search Console MCP

Remote Streamable HTTP MCP server for SuperCape SEO analytics.

## Render
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- MCP endpoint: `/mcp`

## Required environment variables
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GSC_SITE_URL=sc-domain:supercape.in`

Never commit the Google service-account JSON key.

## Tools
- `gsc_list_sites`
- `gsc_search_analytics`
- `gsc_top_opportunities`
