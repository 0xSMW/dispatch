import { Link } from "react-router-dom";
import { Empty } from "../components/Empty";

export function NotFound() {
  return (
    <div className="page">
      <Empty
        title="Page not found"
        body="Check the address, or go back to your emails."
        action={
          <Link className="button secondary small" to="/emails">
            Emails
          </Link>
        }
      />
    </div>
  );
}
