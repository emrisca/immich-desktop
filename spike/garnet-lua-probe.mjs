// Probes which Redis commands Garnet's Lua sandbox can call, since BullMQ's
// scripts fail with "Unknown Redis command called from script".
import IORedis from "ioredis";

const r = new IORedis({ host: process.argv[2] ?? "127.0.0.1", port: Number(process.argv[3] ?? 6389) });

const commands = [
  ["SET", "SET k v"],
  ["GET", "GET k"],
  ["HSET", "HSET h f v"],
  ["HGETALL", "HGETALL h"],
  ["ZADD", "ZADD z 1 m"],
  ["ZRANGE", "ZRANGE z 0 -1"],
  ["LPUSH", "LPUSH l a"],
  ["RPUSH", "RPUSH l b"],
  ["LRANGE", "LRANGE l 0 -1"],
  ["LMOVE", "LMOVE l l LEFT RIGHT"],
  ["RPOPLPUSH", "RPOPLPUSH l l"],
  ["XADD", "XADD s * f v"],
  ["PUBLISH", "PUBLISH ch hi"],
  ["EXPIRE", "EXPIRE k 10"],
  ["DEL", "DEL k"],
  ["INCR", "INCR n"],
  ["SADD", "SADD set a"],
  ["SMEMBERS", "SMEMBERS set"],
  ["ZSCORE", "ZSCORE z m"],
  ["HINCRBY", "HINCRBY h c 1"],
  ["EXISTS", "EXISTS k"],
  ["TYPE", "TYPE k"],
  ["PEXPIRE", "PEXPIRE k 1000"],
  ["ZREM", "ZREM z m"],
  ["LREM", "LREM l 0 a"],
];

for (const [name, body] of commands) {
  const script = `redis.call(${body
    .split(" ")
    .map((t) => JSON.stringify(t))
    .join(",")}) return 1`;
  try {
    await r.eval(script, 0);
    console.log(`ok    ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}  ${error.message}`);
  }
}

await r.quit();
