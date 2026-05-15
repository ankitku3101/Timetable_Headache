"use client";

import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { cn } from "@/lib/utils";

// Sheet = right-side slide-in panel built on @base-ui/react/drawer
const Sheet = DrawerPrimitive.Root;

const SheetBackdrop = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Backdrop>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DrawerPrimitive.Backdrop
    ref={ref}
    className={cn("fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity", className)}
    {...props}
  />
));
SheetBackdrop.displayName = "SheetBackdrop";

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DrawerPrimitive.Popup>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Popup> & { side?: "right" | "left" }
>(({ className, children, side = "right", ...props }, ref) => (
  <DrawerPrimitive.Portal>
    <SheetBackdrop />
    <DrawerPrimitive.Viewport className="fixed inset-0 z-50 pointer-events-none">
      <DrawerPrimitive.Popup
        ref={ref}
        className={cn(
          "absolute top-0 h-full w-80 max-w-[90vw] bg-background shadow-xl",
          "flex flex-col overflow-hidden pointer-events-auto",
          "transition-transform duration-300",
          side === "right" ? "right-0" : "left-0",
          className,
        )}
        {...props}
      >
        {children}
      </DrawerPrimitive.Popup>
    </DrawerPrimitive.Viewport>
  </DrawerPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 border-b px-4 py-3", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold leading-tight", className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

const SheetClose = DrawerPrimitive.Close;

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose };
