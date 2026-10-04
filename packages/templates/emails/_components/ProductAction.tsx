import type { ReactNode } from "react";
import type { Brand } from "../_theme";
import { Action } from "./Action";
import { If, Unless } from "./If";

// An optional action URL falls back to the product URL in both React and library renders.
export function ProductAction({ brand, href, children }: { brand: Brand; href?: string; children: ReactNode }) {
  return (
    <>
      <If value={href}>
        <Action brand={brand} href={href}>{children}</Action>
      </If>
      <Unless value={href}>
        <If value={brand.productUrl}>
          <Action brand={brand} href={brand.productUrl}>{children}</Action>
        </If>
      </Unless>
    </>
  );
}
