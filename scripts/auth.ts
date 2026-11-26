// Login administration. Runs against the same database as the server, which can stay up.
//
//   bun scripts/auth.ts alta              create or replace the user (password, TOTP secret, backup codes)
//   bun scripts/auth.ts desbloquear       clear the lockout after too many failed attempts
//   bun scripts/auth.ts cerrar-sesiones   end every session on every device
//
// In Docker: docker compose exec gastos bun scripts/auth.ts <command>
import path from "node:path";
import { createAuth, MIN_PASSWORD } from "../src/auth.ts";
import { openStore } from "../src/store.ts";

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dir, "..", "data"));

// Piped input (no terminal): read lines in order, for scripted use.
let piped: string[] | undefined;
async function readLine(question: string, hidden: boolean): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    piped ??= (await Bun.stdin.text()).split(/\r?\n/);
    const line = piped.shift() ?? "";
    process.stdout.write("\n");
    return line;
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise(resolve => {
    let buf = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(), resolve(buf);
        if (ch === "\u0003") return finish(), process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") {
          if (buf && !hidden) process.stdout.write("\b \b");
          buf = buf.slice(0, -1);
        } else if (ch >= " ") {
          buf += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const cmd = process.argv[2];
const store = openStore(DATA_DIR);
const auth = createAuth(store);

try {
  if (cmd === "alta") {
    if (auth.hasUser()) {
      console.log("Ya existe un usuario. Si continúas, se reemplazan la contraseña, el secreto TOTP y los códigos de respaldo, y se cierran todas las sesiones.");
      if ((await readLine("Escribe SI para continuar: ", false)).trim() !== "SI") fail("Cancelado.");
    }
    const pass = await readLine(`Contraseña nueva (mínimo ${MIN_PASSWORD} caracteres): `, true);
    if (pass.length < MIN_PASSWORD) fail(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
    if ((await readLine("Repítela: ", true)) !== pass) fail("Las contraseñas no coinciden.");
    const { secret, uri, codes } = await auth.setUser(pass);
    console.log(`
Usuario listo. Esto se muestra una sola vez.

1. En tu app de autenticación, agrega una cuenta con clave manual (basada en tiempo):
     ${secret.match(/.{1,4}/g)!.join(" ")}
   o importa esta URI:
     ${uri}

2. Códigos de respaldo, de un solo uso. Sirven en lugar del código de la app si la pierdes.
   Guárdalos fuera de este servidor:
${codes.map(c => `     ${c}`).join("\n")}

3. Entra a la app con la contraseña y el código de 6 dígitos.`);
  } else if (cmd === "desbloquear") {
    if (!auth.hasUser()) fail("No hay usuario. Créalo con: bun scripts/auth.ts alta");
    auth.unlock();
    console.log("Bloqueo eliminado: ya se puede volver a intentar entrar.");
  } else if (cmd === "cerrar-sesiones") {
    auth.logoutAll();
    console.log("Sesiones cerradas. Los navegadores abiertos vuelven al login en menos de 30 segundos.");
  } else {
    fail("Uso: bun scripts/auth.ts alta | desbloquear | cerrar-sesiones");
  }
} finally {
  store.close();
}
