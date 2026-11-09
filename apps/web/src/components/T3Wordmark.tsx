import type { SVGProps } from "react";

import memLogo from "../assets/mem-logo.png";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <image href={memLogo} width="24" height="24" />
    </svg>
  );
}
