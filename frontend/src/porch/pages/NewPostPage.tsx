import { PenSquare } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { EmptyState, ItemButton } from "@/items/ui";

import { Column, PageHeader } from "../components/ui";

/**
 * BRANCH-ONLY STAND-IN (WP-P1.3). The composer is WP-P1.4 (docs/porch-build.md
 * §3.3), which replaces this file before Porch is merged or released. It must
 * never ship: P1.4 follows immediately on this branch.
 */
export function NewPostPage() {
  const navigate = useNavigate();
  return (
    <Column>
      <PageHeader title="New post" back />
      <EmptyState
        className="mx-4 mt-4 md:mx-0"
        icon={PenSquare}
        title="The composer comes in the next step"
        text="Posting photos and news is built in WP-P1.4, straight after this one."
        action={
          <ItemButton variant="secondary" onClick={() => navigate("/porch/")}>
            Back to your feed
          </ItemButton>
        }
      />
    </Column>
  );
}
