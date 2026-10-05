// Compila el sitio para Vercel: copia la app a dist/ y genera js/config.js
// con las variables de entorno. Si una variable no existe se usa el valor
// de js/config.js (útil para correr en local sin configurar nada).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const dist = path.join(raiz, "dist");

// Valores por defecto: los de js/config.js
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(raiz, "js/config.js"), "utf8"), ctx);
const base = ctx.window.ARIGA_CONFIG;

const config = {
  SUPABASE_URL: process.env.SUPABASE_URL || base.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY || base.SUPABASE_KEY,
  SCHEMA: process.env.SUPABASE_SCHEMA || base.SCHEMA,
  ZONA_HORARIA: process.env.ZONA_HORARIA || base.ZONA_HORARIA,
};

// Bloquea el despliegue si por error se configura la clave secreta
const payloadJwt = k => { try { return JSON.parse(Buffer.from(k.split(".")[1], "base64url")); } catch { return {}; } };
if (config.SUPABASE_KEY.startsWith("sb_secret_") || payloadJwt(config.SUPABASE_KEY).role === "service_role") {
  throw new Error("SUPABASE_KEY es una clave secreta. Use la clave publicable (sb_publishable_...).");
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const item of ["index.html", "css", "js", "img"]) {
  fs.cpSync(path.join(raiz, item), path.join(dist, item), { recursive: true });
}
fs.writeFileSync(
  path.join(dist, "js/config.js"),
  `// Generado en el despliegue por scripts/build.mjs\nwindow.ARIGA_CONFIG = ${JSON.stringify(config, null, 2)};\n`
);

const origen = env => (process.env[env] ? `variable ${env}` : "js/config.js");
console.log("Build listo en dist/");
console.log(`  SUPABASE_URL  = ${config.SUPABASE_URL} (${origen("SUPABASE_URL")})`);
console.log(`  SUPABASE_KEY  = ${config.SUPABASE_KEY.slice(0, 18)}... (${origen("SUPABASE_KEY")})`);
console.log(`  SCHEMA        = ${config.SCHEMA} (${origen("SUPABASE_SCHEMA")})`);
console.log(`  ZONA_HORARIA  = ${config.ZONA_HORARIA} (${origen("ZONA_HORARIA")})`);
