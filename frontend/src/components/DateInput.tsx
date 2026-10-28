import { forwardRef, type InputHTMLAttributes } from "react";
export const DateInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className = "", onClick, ...props }, ref) => (
  <input
    {...props}
    ref={ref}
    className={"date-click-picker " + className}
    onClick={(e) => {
      onClick?.(e);
      try {
        e.currentTarget.showPicker?.();
      } catch {
        /* Native indicator remains available in older browsers. */
      }
    }}
  />
));
