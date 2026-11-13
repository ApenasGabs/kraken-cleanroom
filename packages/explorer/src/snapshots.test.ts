import { describe, expect, it } from "vitest";
import {
  captureA11ySnapshot,
  extractAriaSnapshotFromHtml,
  generateMockPng,
  reduceDomSnapshot,
} from "./index.js";

describe("F1-05: Explorer screenshots multi-viewport + snapshots DOM/a11y", () => {
  describe("generateMockPng", () => {
    it("gera buffer PNG válido com assinatura mágica e cabeçalho IHDR", () => {
      const png = generateMockPng(375, 812);
      expect(Buffer.isBuffer(png)).toBe(true);
      // Assinatura PNG: \x89PNG\r\n\x1a\n
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      // Chunk IHDR: comprimento 13, tipo IHDR
      expect(png.readUInt32BE(8)).toBe(13);
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(375);
      expect(png.readUInt32BE(20)).toBe(812);
    });

    it("gera hashes diferentes para viewports com dimensões distintas", () => {
      const p375 = generateMockPng(375, 812);
      const p768 = generateMockPng(768, 1024);
      const p1440 = generateMockPng(1440, 900);

      expect(p375.equals(p768)).toBe(false);
      expect(p768.equals(p1440)).toBe(false);
      expect(p375.equals(p1440)).toBe(false);
    });
  });

  describe("reduceDomSnapshot", () => {
    it("remove todas as tags <script> (inline, externas e com atributos)", () => {
      const rawHtml = `
        <html>
          <head>
            <script src="/static/bundle.js" type="module"></script>
            <script>console.log("internal token: secret123");</script>
          </head>
          <body>
            <div>Conteúdo</div>
            <script async defer src="https://analytics.example.com/tag.js"></script>
          </body>
        </html>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      expect(reduced).not.toContain("<script");
      expect(reduced).not.toContain("</script>");
      expect(reduced).not.toContain("internal token");
      expect(reduced).not.toContain("analytics.example.com");
    });

    it("remove todas as tags <style> (inline, com atributos e css)", () => {
      const rawHtml = `
        <html>
          <head>
            <style>body { font-family: sans-serif; color: red; }</style>
            <style type="text/css">.hidden { display: none; }</style>
          </head>
          <body>
            <p>Texto</p>
          </body>
        </html>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      expect(reduced).not.toContain("<style");
      expect(reduced).not.toContain("</style>");
      expect(reduced).not.toContain("font-family");
      expect(reduced).not.toContain(".hidden");
    });

    it("remove comentários HTML e blocos <noscript>", () => {
      const rawHtml = `
        <body>
          <!-- Comentário confidencial de desenvolvimento -->
          <noscript><p>Habilite o JavaScript</p></noscript>
          <main>Aplicação</main>
        </body>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      expect(reduced).not.toContain("<!--");
      expect(reduced).not.toContain("Comentário confidencial");
      expect(reduced).not.toContain("<noscript");
      expect(reduced).toContain("<main>Aplicação</main>");
    });

    it("reduz SVGs pesados preservando tags básicas", () => {
      const complexPath = "M 10 10 L 90 90 L 10 90 Z ".repeat(30);
      const rawHtml = `
        <div>
          <svg width="24" height="24" viewBox="0 0 24 24" class="icon-heavy">
            <path d="${complexPath}" fill="currentColor" />
          </svg>
        </div>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      expect(reduced).toContain(
        '<svg width="24" height="24" viewBox="0 0 24 24" class="icon-heavy" data-cleanroom-reduced="svg"></svg>',
      );
      expect(reduced).not.toContain(complexPath);
    });

    it("trunca atributos data-* longos (> 40 chars) e data: URIs", () => {
      const longPayload = "x".repeat(120);
      const rawHtml = `
        <div data-testid="short" data-state="active" data-tracking-payload="${longPayload}">
          <img src="data:image/png;base64,${"A".repeat(200)}" alt="foto" />
        </div>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      expect(reduced).toContain('data-testid="short"');
      expect(reduced).toContain('data-state="active"');
      expect(reduced).toContain('data-tracking-payload="[TRUNCATED]"');
      expect(reduced).toContain('src="data:[TRUNCATED]"');
      expect(reduced).not.toContain(longPayload);
    });

    it("trunca nós de texto acima de 200 caracteres para no máximo 200 caracteres (LGPD e clean room)", () => {
      const longParagraph =
        "Este é um texto muito longo que descreve detalhes minuciosos e dados de usuários ".repeat(
          6,
        );
      expect(longParagraph.length).toBeGreaterThan(300);

      const rawHtml = `
        <article>
          <h1>Título curto</h1>
          <p>${longParagraph}</p>
        </article>
      `;

      const reduced = reduceDomSnapshot(rawHtml);
      // Localiza o texto interno da tag <p>
      const pMatch = reduced.match(/<p>([\s\S]*?)<\/p>/i);
      expect(pMatch).not.toBeNull();
      const pText = (pMatch?.[1] ?? "").trim();

      expect(pText.length).toBeLessThanOrEqual(200);
      expect(pText.endsWith("...")).toBe(true);

      // Garante que nenhum nó de texto no HTML reduzido excede 200 caracteres
      const allTextNodes = (reduced.match(/>([^<]+)</g) ?? []).map((t) => t.slice(1, -1).trim());
      for (const node of allTextNodes) {
        expect(node.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("captureA11ySnapshot e extractAriaSnapshotFromHtml", () => {
    it("extrai árvore de acessibilidade ariaSnapshot no formato YAML a partir de HTML", () => {
      const html = `
        <html>
          <head><title>Cleanroom Demo</title></head>
          <body>
            <header>
              <h1>Painel de Controle</h1>
              <nav>
                <a href="/projects">Projetos</a>
                <a href="/help">Ajuda</a>
              </nav>
            </header>
            <main>
              <h2>Novo Projeto</h2>
              <button type="submit">Salvar</button>
            </main>
          </body>
        </html>
      `;

      const yaml = extractAriaSnapshotFromHtml(html);
      expect(yaml).toContain("- document:");
      expect(yaml).toContain('- heading "Cleanroom Demo" [level=1]');
      expect(yaml).toContain('- heading "Painel de Controle" [level=1]');
      expect(yaml).toContain('- link "Projetos"');
      expect(yaml).toContain('- link "Ajuda"');
      expect(yaml).toContain('- heading "Novo Projeto" [level=2]');
      expect(yaml).toContain('- button "Salvar"');
    });

    it("captureA11ySnapshot prioriza locator('body').ariaSnapshot() do Playwright 1.49+", async () => {
      const mockPlaywrightPage = {
        locator: (selector: string) => {
          if (selector === "body") {
            return {
              ariaSnapshot: async () => `- document:\n  - heading "Mock Body" [level=1]`,
            };
          }
          return {};
        },
      } as unknown as import("playwright-core").Page;

      const result = await captureA11ySnapshot(mockPlaywrightPage);
      expect(result.format).toBe("ariaSnapshot");
      expect(result.snapshot).toContain('- heading "Mock Body" [level=1]');
    });

    it("captureA11ySnapshot utiliza fallback para accessibility.snapshot() legado", async () => {
      const mockLegacyPage = {
        locator: () => ({}),
        accessibility: {
          snapshot: async () => ({ role: "WebArea", name: "Legacy Tree" }),
        },
      } as unknown as import("playwright-core").Page;

      const result = await captureA11ySnapshot(mockLegacyPage);
      expect(result.format).toBe("accessibilityTree");
      expect(result.snapshot).toEqual({ role: "WebArea", name: "Legacy Tree" });
    });

    it("captureA11ySnapshot utiliza fallback estruturado a partir do HTML quando página não possui API", async () => {
      const mockBarePage = {} as unknown as import("playwright-core").Page;
      const html = "<h1>Fallback Title</h1><button>Ação</button>";

      const result = await captureA11ySnapshot(mockBarePage, html);
      expect(result.format).toBe("ariaSnapshot");
      expect(result.snapshot).toContain('- heading "Fallback Title" [level=1]');
      expect(result.snapshot).toContain('- button "Ação"');
    });
  });
});
