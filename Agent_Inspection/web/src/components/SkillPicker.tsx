import { useEffect, useMemo, useState } from 'react';
import { api, type SkillSummary } from '../api.ts';

interface SkillPickerProps {
  readonly onPick: (skill: SkillSummary) => void;
}

export function SkillPicker({ onPick }: SkillPickerProps) {
  const [skills, setSkills] = useState<SkillSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills), (e: Error) => setError(e.message));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = skills ?? [];
    return (q ? list.filter((s) => `${s.name} ${s.description} ${s.source}`.toLowerCase().includes(q)) : list).slice(0, 60);
  }, [skills, query]);

  if (error) return <p className="error-text">{error}</p>;
  if (!skills) return <p className="muted">Loading skills…</p>;
  return (
    <div className="skill-picker">
      <input className="text-input" placeholder={`Search ${skills.length} skills…`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
      <ul className="skill-list">
        {filtered.map((skill) => (
          <li key={skill.id}>
            <button className="skill-row" onClick={() => onPick(skill)}>
              <span className="skill-name">{skill.name}</span>
              <span className="skill-source">{skill.source}</span>
              <span className="skill-desc">{skill.description || 'No description'}</span>
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted">No matching skills.</li>}
      </ul>
    </div>
  );
}
