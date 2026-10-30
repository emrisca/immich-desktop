#!/bin/bash
# M0 spike A, Linux leg: PostgreSQL 17 + VectorChord from the published
# linux-gnu release, on Debian. Run as root inside WSL/VM:
#   wsl -d Debian --user root --exec /bin/bash <this file>
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
PG=17
VC=1.1.1

echo "### 1. packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg unzip lsb-release >/dev/null

echo "### 2. PGDG repository"
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq postgresql-$PG >/dev/null
/usr/lib/postgresql/$PG/bin/pg_config --version

echo "### 3. VectorChord $VC (published linux-gnu build)"
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/vchord.zip" \
  "https://github.com/tensorchord/VectorChord/releases/download/$VC/postgresql-$PG-vchord_${VC}_x86_64-linux-gnu.zip"
unzip -o -q "$TMP/vchord.zip" -d "$TMP/x"
find "$TMP/x" -type f | head -20
if [ -d "$TMP/x/usr" ]; then
  cp -av "$TMP/x/usr/lib/postgresql/$PG/lib/"* /usr/lib/postgresql/$PG/lib/ 2>/dev/null || true
  cp -av "$TMP/x/usr/share/postgresql/$PG/extension/"* /usr/share/postgresql/$PG/extension/ 2>/dev/null || true
else
  cp -v "$TMP/x/lib/"* /usr/lib/postgresql/$PG/lib/
  cp -v "$TMP/x/share/extension/"* /usr/share/postgresql/$PG/extension/
fi

echo "### 4. preload + start"
CONF=/etc/postgresql/$PG/main/postgresql.conf
grep -q "shared_preload_libraries = 'vchord'" "$CONF" || \
  echo "shared_preload_libraries = 'vchord'" >> "$CONF"
pg_ctlcluster $PG main restart
su postgres -c "psql -tAc \"select current_setting('shared_preload_libraries')\""

echo "### 5. extensions"
su postgres -c "psql -c 'create database immich_spike'" || true
su postgres -c "psql -d immich_spike -c 'create extension vchord;'" 
su postgres -c "psql -d immich_spike -c 'create extension vector;'"
su postgres -c "psql -d immich_spike -c '\dx'" | grep -E 'vchord|vector'

echo "### 6. a real vchordrq index"
su postgres -c "psql -v ON_ERROR_STOP=1 -d immich_spike" <<'SQL'
create table vc_probe (id int primary key, embedding vector(8));
insert into vc_probe select g, (select array_agg(random())::vector from generate_series(1,8)) from generate_series(1,200) g;
create index vc_probe_idx on vc_probe using vchordrq (embedding vector_l2_ops) with (options = $$[build.internal] lists = [1]$$);
set enable_seqscan = off;
explain (costs off) select id from vc_probe order by embedding <-> (select embedding from vc_probe where id = 1) limit 5;
select count(*) as hits from (select id from vc_probe order by embedding <-> (select embedding from vc_probe where id = 1) limit 5) s;
SQL

echo "### 7. valkey (queue)"
apt-get install -y -qq valkey >/dev/null 2>&1 || apt-get install -y -qq redis-server >/dev/null
(valkey-server --port 6391 --daemonize yes 2>/dev/null || redis-server --port 6391 --daemonize yes)
sleep 1
valkey-cli -p 6391 ping 2>/dev/null || redis-cli -p 6391 ping

echo "LINUX_LEG_PASS"
