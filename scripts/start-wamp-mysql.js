import { spawn } from "node:child_process";
import { open, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDirectory = path.join(projectRoot, "data");
const mysqlPort = Number(process.env.DB_PORT || 3306);
const mysqlHost = process.env.DB_HOST || "127.0.0.1";

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: mysqlHost, port: mysqlPort });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function findMysqlHome() {
  const configured = process.env.WAMP_MYSQL_HOME?.trim();
  if (configured && existsSync(path.join(configured, "bin", "mysqld.exe"))) return configured;
  const mysqlRoot = process.env.WAMP_MYSQL_ROOT || "C:\\wamp64\\bin\\mysql";
  let entries;
  try { entries = await readdir(mysqlRoot, { withFileTypes: true }); }
  catch { throw new Error(`Không tìm thấy thư mục MySQL Wampserver: ${mysqlRoot}. Có thể đặt WAMP_MYSQL_ROOT trong .env.`); }
  const candidates = entries.filter((entry) => entry.isDirectory() && /^mysql/i.test(entry.name))
    .map((entry) => path.join(mysqlRoot, entry.name))
    .filter((home) => existsSync(path.join(home, "bin", "mysqld.exe")) && existsSync(path.join(home, "my.ini")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!candidates.length) throw new Error("Không tìm thấy mysqld.exe/my.ini trong Wampserver.");
  return candidates[0];
}

async function waitUntilReady(child, home, errorLogPath) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portIsOpen()) return;
    if (child.exitCode != null) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const log = await readFile(errorLogPath, "utf8").catch(() => "");
  const detail = log.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  throw new Error(`MySQL chưa sẵn sàng ở ${mysqlHost}:${mysqlPort}. Kiểm tra ${path.join(home, "my.ini")}.${detail ? `\n${detail}` : ""}`);
}

try {
  if (await portIsOpen()) {
    console.log(`MySQL đã chạy tại ${mysqlHost}:${mysqlPort}.`);
    process.exit(0);
  }
  if (process.platform !== "win32") throw new Error("Lệnh này dành cho Wampserver trên Windows.");
  const home = await findMysqlHome();
  const server = path.join(home, "bin", "mysqld.exe");
  const optionsFile = path.join(home, "my.ini");
  await mkdir(dataDirectory, { recursive: true });
  const stdout = await open(path.join(dataDirectory, "mysql-local.out.log"), "a");
  const stderr = await open(path.join(dataDirectory, "mysql-local.err.log"), "a");
  const child = spawn(server, [
    `--defaults-file=${optionsFile}`,
    "--defaults-group-suffix=wampmysqld64",
    "--bind-address=127.0.0.1",
    "--console",
  ], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout.fd, stderr.fd],
  });
  child.once("error", (error) => console.error(`Không khởi động được MySQL: ${error.message}`));
  child.unref();
  await stdout.close();
  await stderr.close();
  await waitUntilReady(child, home, path.join(dataDirectory, "mysql-local.err.log"));
  console.log(`Đã khởi động MySQL cục bộ tại ${mysqlHost}:${mysqlPort}.`);
  console.log("Wampserver có thể chưa hiện biểu tượng xanh vì tiến trình này không chạy dưới dạng Windows service.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
