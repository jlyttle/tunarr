import json
import posixpath
import shlex
import sys
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from commercials.catalog import Ad, Catalog

HOST = "root@192.168.1.227"
SSH = "/usr/bin/ssh"


@dataclass
class DeliveryPlan:
    push: list[tuple[str, str, str]] = field(default_factory=list)  # (ad_id, pool, remote)
    delete: list[str] = field(default_factory=list)


def remote_path(ad: Ad, pool: str, root: str) -> str:
    return f"{root.rstrip('/')}/{pool}/{ad.ad_id}.mp4"


def push_args(local: str, remote: str) -> list[str]:
    """ssh command that streams stdin to `remote` (write to .part, then rename)."""
    tmp = remote + ".part"
    script = (
        f"umask 000; mkdir -p {shlex.quote(posixpath.dirname(remote))}"
        f" && cat > {shlex.quote(tmp)} && mv {shlex.quote(tmp)} {shlex.quote(remote)}"
    )
    return [SSH, HOST, script]


def delete_args(remotes: list[str]) -> list[str]:
    quoted = " ".join(shlex.quote(r) for r in remotes)
    return [SSH, HOST, f"rm -f {quoted}"]


def plan_delivery(catalog: Catalog, active: dict[str, set[str]], root: str) -> DeliveryPlan:
    plan = DeliveryPlan()
    for ad_id in sorted(catalog.ads):
        ad = catalog.ads[ad_id]
        for pool in sorted(active):
            if ad_id in active[pool]:
                remote = remote_path(ad, pool, root)
                if ad.delivered.get(pool) != remote:
                    plan.push.append((ad_id, pool, remote))
        for pool, remote in sorted(ad.delivered.items()):
            if ad_id not in active.get(pool, set()):
                plan.delete.append(remote)
    return plan


def apply_delivery_result(
    catalog: Catalog, pushed: list[tuple[str, str, str]], deleted: list[str]
) -> None:
    for ad_id, pool, remote in pushed:
        catalog.ads[ad_id].delivered[pool] = remote
    gone = set(deleted)
    for ad in catalog.ads.values():
        for pool in [p for p, r in ad.delivered.items() if r in gone]:
            del ad.delivered[pool]


def unraid_root(config_path: Path | None = None) -> str:
    path = config_path or Path(__file__).resolve().parent.parent / "config" / "sources.json"
    root = json.loads(path.read_text()).get("unraid_root")
    if not root:
        raise RuntimeError("unraid_root is not set in config/sources.json")
    return root


def deliver(catalog: Catalog, active: dict[str, set[str]], root: str) -> DeliveryPlan:
    """Push pending ads one at a time, then delete retired ones. Failed transfers stay pending."""
    plan = plan_delivery(catalog, active, root)
    pushed = []
    for ad_id, pool, remote in plan.push:
        try:
            with open(catalog.ads[ad_id].local_path, "rb") as f:
                r = subprocess.run(push_args(catalog.ads[ad_id].local_path, remote),
                                   stdin=f, stderr=subprocess.PIPE)
        except OSError as e:
            print(f"push failed for {ad_id} ({pool}): {e}", file=sys.stderr)
            continue
        if r.returncode == 0:
            pushed.append((ad_id, pool, remote))
        else:
            err = (r.stderr or b"").decode(errors="replace").strip()
            print(f"push failed for {ad_id} ({pool}): {err}", file=sys.stderr)
    deleted: list[str] = []
    if plan.delete and subprocess.run(delete_args(plan.delete), stderr=subprocess.PIPE).returncode == 0:
        deleted = list(plan.delete)
    apply_delivery_result(catalog, pushed, deleted)
    return plan
