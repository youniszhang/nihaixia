import { useId } from 'react';

// Original vector landscape: ink washes, mist, a mountain pavilion and pines.
// Scoped IDs allow multiple landscapes on the same page without SVG collisions.
export default function InkLandscape({ className = '' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`ink-landscape ${className}`} viewBox="0 0 900 360" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-wash`} x1="0" y1="40" x2="0" y2="350" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" stopOpacity=".34" />
          <stop offset=".64" stopColor="currentColor" stopOpacity=".12" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-edge`} cx=".54" cy=".55" r=".56">
          <stop offset=".6" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id={`${id}-fade`}><rect width="900" height="360" fill={`url(#${id}-edge)`} /></mask>
        <filter id={`${id}-ink`} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency=".015 .075" numOctaves="2" seed="8" result="grain" />
          <feDisplacementMap in="SourceGraphic" in2="grain" scale="4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g mask={`url(#${id}-fade)`}>
        <circle cx="660" cy="72" r="29" stroke="currentColor" strokeWidth=".7" opacity=".16" />
        <circle cx="660" cy="72" r="25" fill="currentColor" opacity=".055" />
        <g fill={`url(#${id}-wash)`} filter={`url(#${id}-ink)`}>
          <path opacity=".5" d="M0 278Q45 247 78 256C112 265 136 207 162 212S201 158 219 166 241 125 255 144Q271 169 295 180C320 193 327 126 345 121S366 56 382 68 399 119 411 118C432 115 442 187 466 203S500 175 520 184C541 193 558 137 576 145S603 92 621 111Q649 150 673 170C698 184 720 135 745 149S789 210 818 203 869 185 900 208V360H0Z" />
          <path opacity=".85" d="M180 316C207 297 238 308 256 278S290 254 309 229Q330 203 344 211C359 221 375 157 390 162S409 97 424 111C439 124 435 165 451 174S476 222 490 234 525 220 547 248Q567 263 590 230C605 208 619 220 630 193S653 155 668 168C681 179 681 131 697 142S709 190 722 195C740 201 745 249 773 257S821 245 843 278L900 330V360H180Z" />
          <path d="M0 329C47 301 71 318 102 285S142 262 155 269C173 278 181 235 197 249S217 279 236 274C263 268 282 317 318 310S363 280 391 294C421 313 443 283 470 299S513 313 547 288C571 272 586 303 614 298S658 255 678 270 706 292 731 285C769 274 790 315 822 299S868 282 900 300V360H0Z" />
        </g>
        <g stroke="currentColor" strokeWidth=".8" strokeLinecap="round" opacity=".13">
          <path d="M382 75q-4 43-23 84t-28 54m91-91q-14 59-5 80t-21 63m299-114q-18 47-6 69t-12 44" />
          <path d="M145 283c83-20 112 26 205 7s152-31 239-9 136-12 201-9M100 304c96-16 153 23 248 3s156-10 233-1 166-21 217-8" />
        </g>
        <g stroke="currentColor" strokeWidth="1" opacity=".4" strokeLinejoin="round">
          <path d="m684 141 12-7 12 7m-27 1h30m-23 1v9m16-9v9m-21 1h26m-17-1v-7h8v7m-16-24 12-5 12 5m-22 1h20m-17 0v5m14-5v5m-7-16v5" />
          <path d="m201 251-3-30m0 7-13 5m13-10 10 4m-7 8 13 4m-14-2-16 8m23-2 11 7m-24-20-8-5m22 1 8-4" />
          <path d="m758 273 1-26m0 4-11 5m11-9 8 5m-8 4 13 5m-14-2-13 8m22-6 9 7" />
        </g>
        <g stroke="currentColor" strokeLinecap="round" opacity=".3">
          <path d="m538 101 7-3 7 3m22-17 6-2 6 2" />
          <path d="M583 323q18 6 35 0m-20-1v-16l11 13h-11" />
        </g>
      </g>
    </svg>
  );
}
