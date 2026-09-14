#!/usr/bin/python3
"""agy keyring helper (libsecret, single process — sessions must stay alive).

Usage:
  backup <outfile>            # save agy token items {attrs, secret_b64}
  delete                      # delete items matching service=gemini
  restore <backupfile>        # restore items from backup json
"""
import gi, json, os, sys, base64, time
gi.require_version("Secret", "1")
from gi.repository import Secret

ATTRS = {"service": "gemini", "username": "antigravity"}

def service():
    return Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS)

def items(svc):
    return svc.search_sync(None, ATTRS, Secret.SearchFlags.ALL, None) or []

def do_backup(svc, outfile):
    data = []
    for item in items(svc):
        item.load_secret_sync()
        sec = item.retrieve_secret_sync()
        data.append({
            "attrs": item.get_attributes(),
            "label": item.get_label(),
            "secret_b64": base64.b64encode(sec.get()).decode(),
        })
    os.makedirs(os.path.dirname(outfile), exist_ok=True)
    with open(outfile, "w") as f:
        json.dump({"kind": "agy-keyring-backup", "items": data}, f)
    os.chmod(outfile, 0o600)
    print(json.dumps({"ok": True, "items": len(data), "file": outfile}))

def do_delete(svc):
    n = 0
    for item in items(svc):
        item.delete_sync(None) if hasattr(item, "delete_sync") else None
        n += 1
    print(json.dumps({"ok": True, "deleted": n}))

def do_restore(svc, infile):
    with open(infile) as f:
        doc = json.load(f)
    n = 0
    for rec in doc.get("items", []):
        raw = base64.b64decode(rec["secret_b64"])
        schema = Secret.Schema.new("org.freedesktop.Secret.Generic", Secret.SchemaFlags.NONE,
                                   {"service": Secret.SchemaAttributeType.STRING, "username": Secret.SchemaAttributeType.STRING})
        Secret.password_store_sync(schema, rec.get("attrs", ATTRS), Secret.COLLECTION_DEFAULT,
                                   rec.get("label", "Password for 'antigravity' on 'gemini'"),
                                   raw.decode("utf-8", "ignore"), None)
        n += 1
    print(json.dumps({"ok": True, "restored": n}))

if __name__ == "__main__":
    cmd = sys.argv[1]
    svc = service()
    if cmd == "backup": do_backup(svc, sys.argv[2])
    elif cmd == "delete": do_delete(svc)
    elif cmd == "restore": do_restore(svc, sys.argv[2])
    else: print(json.dumps({"ok": False, "err": "unknown cmd"}))
