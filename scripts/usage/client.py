import json
import sys
from dispatch import Dispatch

contact_id = None
try:
    marker = sys.argv[1]
    email = f"usage-{marker}@example.net"
    client = Dispatch()
    contact = client.create_contact({"email": email, "first_name": "Usage Python", "last_name": marker})
    contact_id = contact["id"]
    if client.contact(email)["id"] != contact_id:
        raise ValueError("Contact lookup mismatch")
    listed = any(row["id"] == contact_id for row in client.contacts(q=email, limit=100)["data"])
    if not listed:
        raise ValueError("Contact absent from list")
    deleted = client.delete_contact(email)["deleted"] is True
    if not deleted:
        raise ValueError("Contact deletion failed")
    print(json.dumps({"id": contact_id, "email": email, "listed": listed, "deleted": deleted}))
except Exception as error:
    print(json.dumps({"id": contact_id, "error": type(error).__name__}))
    sys.exit(1)
