import type { ReactNode } from "react";
import { Collapsible as Primitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
export function Disclosure({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Primitive.Root className="sample-library">
      <Primitive.Trigger className="group flex w-full items-center justify-between gap-3 rounded-sm text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </Primitive.Trigger>
      <Primitive.Content className="pt-3">{children}</Primitive.Content>
    </Primitive.Root>
  );
}
