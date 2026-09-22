import type { ComponentProps } from "react";
import { Slider as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";
export function Slider({
  className,
  ...props
}: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className,
      )}
      {...props}
    >
      <Primitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <Primitive.Range className="absolute h-full bg-primary" />
      </Primitive.Track>
      <Primitive.Thumb className="block size-3.5 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
    </Primitive.Root>
  );
}
