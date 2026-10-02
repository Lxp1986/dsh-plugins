/**
 * Video Studio host half.
 *
 * Registers the agent tools and the `/video-studio` HTTP surface; all media
 * work happens in the shared studio facade. The optional `speechToText` service
 * is resolved lazily, so the plugin also loads in profiles without it.
 *
 * @module @local/dsh-video-studio
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createApi } from './lib/api.js';
import { createStudio } from './lib/studio.js';
import { registerTools } from './lib/tools.js';
import { dshHome } from './lib/util.js';

export const name = 'video-studio';
export const inject = ['tools', 'webServer'];

/**
 * Resolve deployment-varying configuration. Values are validated here rather
 * than through a Config schema so the bundle keeps zero package dependencies.
 */
function resolveConfig(config = {}, ctx) {
  const dataRoot = path.resolve(
    typeof config.dataRoot === 'string' && config.dataRoot.length > 0
      ? config.dataRoot
      : path.join(dshHome(), 'video-studio'),
  );
  // Left unset when the patch does not pin it: the workspace registry is not
  // necessarily mounted yet, so the real default is resolved at first use.
  const configuredMediaRoot = typeof config.mediaRoot === 'string' && config.mediaRoot.length > 0
    ? path.resolve(config.mediaRoot)
    : null;
  return {
    dataRoot,
    mediaRoot: configuredMediaRoot,
    // Exposed as a thunk so studio.init() can resolve it after the whole
    // composition (including the workspace registry) is mounted.
    resolveMediaRoot: () => configuredMediaRoot ?? defaultMediaRoot(ctx),
    allowAnyPath: config.allowAnyPath !== false,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    imageDuration: Number(config.imageDuration) || 5,
    chunkSeconds: Number(config.chunkSeconds) || 18,
    silenceNoise: config.silenceNoise ?? '-32dB',
    silenceMin: Number(config.silenceMin) || 0.4,
    minSpeech: Number(config.minSpeech) || 0.2,
    speechProviderId: config.speechProviderId,
    tts: {
      engine: config.tts?.engine ?? 'say',
      command: config.tts?.command ?? 'say',
      voice: config.tts?.voice ?? 'Tingting',
      rate: Number(config.tts?.rate) || 180,
    },
    basePath: config.basePath ?? '/video-studio',
  };
}

/**
 * The media bin starts in the user's own workspace rather than the profile
 * directory the Host process happens to run in, so imported media is where the
 * user expects it. Falls back to the process directory when no workspace exists.
 */
function defaultMediaRoot(ctx) {
  const candidate = listWorkspaces(ctx)[0]?.path;
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return process.cwd();
}

/** Live workspace roster, newest first; empty when the service is absent. */
function listWorkspaces(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry');
    const list = registry?.list?.() ?? [];
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? '')));
  } catch {
    return [];
  }
}

/** Mount the tools and HTTP routes. */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config, ctx);
  const studio = createStudio({
    config: resolved,
    getSpeech: () => ctx.get('speechToText'),
    resolveMediaRoot: resolved.resolveMediaRoot,
    getWorkspaces: () => listWorkspaces(ctx).map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    })),
  });

  // The token gate is opt-in: a hardening feature that can lock the panel out
  // of its own API (stale page, cached module) must never be on by default.
  const requireToken = config.requireToken === true;

  ctx.effect(() => {
    const disposers = [];
    const token = requireToken ? randomBytes(24).toString('hex') : null;

    // Hand the token to the page itself. If the index cannot be tapped the gate
    // stays disabled rather than locking the panel out of its own API.
    let gated = false;
    try {
      if (!requireToken) throw new Error('token gate disabled by configuration');
      disposers.push(ctx.webServer.tapIndex((html) => {
        const value = JSON.stringify(token);
        let next = html.includes('</head>')
          ? html.replace('</head>', `<script>window.__VIDEO_STUDIO_TOKEN__=${value}</script></head>`)
          : `<script>window.__VIDEO_STUDIO_TOKEN__=${value}</script>${html}`;
        // A DOM attribute keeps the token readable even if a CSP ever blocks
        // inline scripts.
        if (next.includes('<body')) next = next.replace('<body', `<body data-vs-token=${value}`);
        return next;
      }));
      gated = true;
    } catch (error) {
      if (requireToken) {
        ctx.logger?.error?.(`[video-studio] 无法注入访问令牌，接口鉴权已关闭: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    disposers.push(registerTools(ctx, studio));
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: resolved.basePath,
      handler: createApi(studio, { path: resolved.basePath, token: gated ? token : null }),
    }));

    void studio.init().catch((error) => {
      ctx.logger?.error?.(`[video-studio] 初始化失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // Teardown must not throw during profile reload.
        }
      }
    };
  });
}

export { resolveConfig };
