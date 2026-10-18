/** Decorative stationery, drawn in the same soft, outlined style as the station. */
export type WorkspaceDoodleKind = 'books' | 'planner' | 'desk' | 'notice' | 'team';

export function WorkspaceDoodle({ kind }: { readonly kind: WorkspaceDoodleKind }) {
  return <svg className="workspace-doodle" viewBox="0 0 240 160" fill="none" aria-hidden="true" focusable="false">
    <g stroke="#75677d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'books' ? <>
        <path d="M24 134c38-7 151-7 190 0" stroke="#d8cfdb" />
        <path d="m36 111 107-4 30 16-109 5Z" fill="#efc6b3" />
        <path d="m36 111 1 13 27 15 109-5v-11l-109 5Z" fill="#f9e9d2" />
        <path d="m64 128 1 11m6-5 91-5" stroke="#c1a999" />
        <path d="m45 91 109 5 16 12-110-5Z" fill="#b9c8b0" />
        <path d="m45 91-1 12 16 12 110 5v-12l-110-5Z" fill="#faf2e1" />
        <path d="m60 103 0 12m7-6 91 4" stroke="#bcc3a9" />
        <path d="m51 37 58-10 14 61-57 11Z" fill="#c7b6dc" />
        <path d="m109 27 9 5 14 59-9-3" fill="#efe4f6" />
        <path d="m59 36 13 59" stroke="#9480ad" />
        <path d="m74 44 22-4m-20 12 25-4" stroke="#f8f1fc" strokeWidth="3" />
        <path d="m88 65 3 6 7-1-5 5 2 7-6-4-6 4 1-7-5-4 7-1Z" fill="#f6e1a9" strokeWidth="1.8" />
        <path d="m127 49 34 3-5 46-34-3Z" fill="#ecdcae" />
        <path d="m135 59 15 1m-16 8 15 1m-16 8 10 1" stroke="#b99f6b" />
        <path d="m136 53 11 1-1 17-5-4-6 3Z" fill="#da998d" strokeWidth="1.8" />
        <path d="m169 93 26 1-3 32-20-1Z" fill="#d5c2e2" />
        <path d="m174 94-4-28 5-1 4 29Z" fill="#efc0a1" />
        <path d="m170 66 1-10 4 9Z" fill="#75677d" />
        <path d="m182 95 8-33 5 2-9 32" fill="#b4c6ac" />
        <path d="m190 62 5-7 0 9" fill="#f7eddb" />
        <path d="m34 58-5-4m14 2 1-7m155-13 4-5m6 16 7-1" stroke="#bba8c7" />
        <path d="m190 30 2-6m-5 3 7 1" stroke="#cfad83" />
      </> : kind === 'planner' ? <>
        <path d="M28 136c48-6 125-6 184 0" stroke="#d8cfdb" />
        <path d="m54 41 124 4-3 92-127-4Z" fill="#c7b6dc" />
        <path d="m48 37 122 4-3 91-123-4Z" fill="#fff6e7" />
        <path d="m48 37 122 4-1 23-122-4Z" fill="#d5c3e6" />
        <path d="m68 32-1 17m23-16-1 17m23-16-1 17m23-16-1 17m23-16-1 17" strokeWidth="4" />
        <path d="m58 77 97 3m-98 17 98 3m-97 16 96 3m-73-41-2 40m26-39-2 40m26-39-2 40" stroke="#d6c9d8" strokeWidth="1.5" />
        <path d="m62 85 3 4 7-7m17 20 3 4 7-7" stroke="#8b9e7e" strokeWidth="3" />
        <path d="m112 89 9-1m-4-4 0 9" stroke="#b99ac7" />
        <circle cx="169" cy="104" r="27" fill="#edc5af" />
        <circle cx="169" cy="104" r="21" fill="#fff5e4" strokeWidth="1.7" />
        <path d="m169 89 0 15 9 5m-9-25 0 2m20 18-2 0m-18 20 0-2m-20-18 2 0" />
        <path d="m181 67 7-7 6 5-7 7-4 0Zm6-7 17-18q4-4 8 0t-1 8l-17 15" fill="#b9c8b0" />
        <path d="m185 76 14-7" stroke="#c1b2cb" />
        <path d="m29 74-6-3m11-8-1-7m165 62 7 2m-14-84 1-6" stroke="#bba8c7" />
      </> : kind === 'desk' ? <>
        <path d="M25 132c43-5 150-5 191 0" stroke="#d8cfdb" />
        <path d="m39 117 142 0 20 12-143 3Z" fill="#ecd4b7" />
        <path d="m39 117 0 13 19 12 143-4v-9l-143 3Z" fill="#f9ead3" />
        <path d="m67 52 99 2-4 61-100-2Z" fill="#c5b3d9" />
        <path d="m75 61 82 2-3 42-83-2Z" fill="#f9f3fb" />
        <path d="m81 70 23 1m-24 8 50 1m-50 7 37 1" stroke="#b5a0c6" />
        <path d="m62 113 100 2 17 13-112-2Z" fill="#e8dcf0" />
        <path d="m99 117 43 1m-47 4 54 1" stroke="#b5a0c6" strokeWidth="1.5" />
        <path d="m178 111 0-49-23-13" stroke="#a38a6d" strokeWidth="5" />
        <path d="m144 36 15 8-11 27-26-13Z" fill="#b6c7aa" />
        <path d="m122 58 26 13m-8 7-2 8m-13-12-5 7" stroke="#d8bd89" />
        <ellipse cx="178" cy="116" rx="16" ry="5" fill="#b6c7aa" />
        <path d="m35 89 20 0-2 23-15 0Z" fill="#edc2ad" />
        <path d="m55 92q13-1 10 9t-12 5" stroke="#c79782" />
        <path d="m43 82q-4-6 1-11t-1-9" stroke="#bba8c7" strokeWidth="1.8" />
        <path d="m34 42-5-4m14 2 1-7m145 7 4-5m6 16 7-1" stroke="#bba8c7" />
      </> : kind === 'notice' ? <>
        <path d="M30 133c41-5 130-5 177 0" stroke="#d8cfdb" />
        <path d="m64 36 97 6-6 91-98-5Z" fill="#f9edd6" />
        <path d="m75 54 10 1-1 10-10-1Zm-2 25 10 1-1 10-10-1Z" fill="#e3d6ee" />
        <path d="m77 58 2 3 6-5m-10 27 2 3 6-5" stroke="#9b80ac" strokeWidth="2" />
        <path d="m97 61 41 3m-43 23 39 2m-63 21 60 4" stroke="#c2b1c7" />
        <path d="m99 28 23 2-1 17-24-1Z" fill="#d8c3e5" />
        <circle cx="110" cy="34" r="3" fill="#a28ab4" strokeWidth="1.5" />
        <path d="m126 92 68-9 6 38-67 10Z" fill="#e9c6b0" />
        <path d="m128 94 37 15 28-24m-60 46 23-26m43 16-22-20" stroke="#b6928a" strokeWidth="1.8" />
        <path d="m178 43q12 0 12 17l4 9-32 0 4-9q0-17 12-17Z" fill="#d8c5e5" />
        <path d="m174 73q4 6 8 0m-4-36 0 5" stroke="#9b80ac" />
        <path d="m157 45-5-5m47 6 5-4m-33-12-2-6m-13 18-5-3" stroke="#c4a679" />
      </> : <>
        <path d="M24 135c44-6 155-6 192 0" stroke="#d8cfdb" />
        <path d="m48 52 43-15 45 17 49-13-4 79-47 13-44-18-45 15Z" fill="#faf0da" />
        <path d="m91 37-1 78m46-61-2 79" stroke="#c8b2cc" />
        <path d="m66 92q15-32 33-17t26 9q25-28 43-7" stroke="#b2be9f" strokeDasharray="4 6" strokeWidth="3" />
        <circle cx="66" cy="92" r="5" fill="#e5b79d" />
        <path d="m168 56 3 8 9 1-7 5 2 9-7-5-7 5 2-9-7-5 9-1Z" fill="#cbb5dc" strokeWidth="1.8" />
        <path d="m23 87 39-14 7 29-39 13Z" fill="#e6c4b1" />
        <path d="m34 91 17-6m-15 13 19-7" stroke="#bd9285" strokeWidth="1.8" />
        <path d="m167 121 25-28 7 7-25 28-12 5Z" fill="#b9c8b0" />
        <path d="m162 133 5-12 7 7Z" fill="#f9edd6" />
        <path d="m192 93 4-4q4-4 7 0t-1 8l-3 3" fill="#d3bddf" />
        <path d="m28 44-6-3m15-4 1-7m161-1 4-5m6 16 7-1" stroke="#bba8c7" />
      </>}
    </g>
  </svg>;
}
