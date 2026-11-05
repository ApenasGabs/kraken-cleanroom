# 08 - Integrações e deploy

## 1. Browserless (Chrome remoto)

- Conexão: `chromium.connectOverCDP(process.env.CLEANROOM_BROWSER_WS_ENDPOINT)`.
- O endpoint inclui o token como query string. Ele **nunca** aparece em logs: o logger deve redigir `token=` em qualquer URL.
- Um `BrowserContext` por job; fechar sempre em `finally`.
- Concorrência: respeitar `CLEANROOM_MAX_CONCURRENT_JOBS` (default 1) para não saturar o Browserless compartilhado com outros agentes (Sentinel, `ux-test`).
- Teste de conectividade: `cleanroom doctor` (story F0-05) verifica CDP, data dir, LLM e imprime diagnóstico sem expor segredos.

## 2. Paperclip

Modelo: **cada análise = uma issue** no Paperclip.

- Agente executor sugerido: **Kraken Cartographer** (a ser criado pelo Pai do Kraken), com uma skill `kraken-cleanroom` que ensina a:
  1. Gerar o manifesto com `cleanroom_init_manifest` e pedir confirmação do board (approval gate) antes de `cleanroom_start_job`.
  2. Acompanhar com `cleanroom_status` em heartbeats (job roda no serviço, não no heartbeat).
  3. Em `awaiting_human`, comentar na issue com `message` + `liveUrl` e aguardar.
  4. Em `completed`, anexar `report.md` e `index.json` como work product da issue.
- **Kraken Sentinel** revisa o relatório (consistência, evidências, sem conteúdo copiado).
- **Pai do Kraken** faz gap analysis contra o repo destino e quebra em issues para o **Kraken Forge**, que implementa lendo **só** o relatório (sala limpa).

A skill do Paperclip é entregável da Fase 2 (story F2-08).

## 3. KrakenBridge-Web

- Comando de chat `/cleanroom <url>`: chama `initManifest`, mostra o YAML para edição/confirmação e chama `start`.
- Painel de job: consome `GET /v1/jobs/:id/events` (SSE) para progresso e mostra o handoff pendente com botão "Abrir live view" e "Concluí".
- Visualizador de relatório: renderiza markdown + mermaid e links de evidência abrindo `/blob`.

Implementação no repo do KrakenBridge-Web é **fora deste repo**. Aqui só garantimos API estável e documentada (Fase 3).

## 4. Antigravity / Kraken CLI

Registrar o MCP em modo stdio em dev:

```json
{
  "mcpServers": {
    "kraken-cleanroom": {
      "command": "node",
      "args": ["/caminho/kraken-cleanroom/packages/mcp-server/dist/index.js", "--stdio"],
      "env": { "CLEANROOM_DATA_DIR": "/caminho/data" }
    }
  }
}
```

Em produção, apontar para o HTTP streamable do serviço no Dell (`http://<dell>:4870/mcp`).

## 5. Base de conhecimento

- Ao concluir um job, o Pai do Kraken registra um resumo no AI Memory (projeto do alvo ou `kraken-cleanroom`) e o relatório no Anytype. Isso é feito pelo agente, não pelo serviço.

## 6. Deploy no servidor Dell

- Imagem: `docker/Dockerfile` multi-stage (`node:22-bookworm-slim`; build com pnpm; runtime só com `dist` e deps de produção; usuário não-root).
- **Não** instalar browsers na imagem (`playwright-core` + CDP remoto).
- Volume: `/data` -> `CLEANROOM_DATA_DIR`.
- `docker/compose.yaml` de exemplo:

```yaml
services:
  kraken-cleanroom:
    image: ghcr.io/apenasgabs/kraken-cleanroom:latest
    restart: unless-stopped
    env_file: .env
    environment:
      CLEANROOM_DATA_DIR: /data
      CLEANROOM_HTTP_PORT: "4870"
    volumes:
      - ./data:/data
    ports:
      - "4870:4870"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:4870/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    mem_limit: 1g
```

- Host do Dell tem rootfs imutável (ZimaOS): **tudo via container**, nada de `apt-get` no host.
- CI publica a imagem no GHCR em tag `v*` (story F3-06).
