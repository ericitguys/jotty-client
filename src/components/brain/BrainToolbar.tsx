import { useMemo, useState } from 'react';
import type { BrainPrefs, BrainFilterFlags } from '../../stores/store';
import type { BrainVMNode } from './brainView';
import { searchNodes } from './brainView';

interface Props {
  prefs: BrainPrefs;
  focusId: string | null;
  scopeLocal: boolean;
  nodes: BrainVMNode[];
  onChangePrefs: (patch: Partial<BrainPrefs>) => void;
  onSearchPick: (id: string) => void;
  onDimensionChange: (d: '2d' | '3d') => void;
  onScopeLocalChange: (v: boolean) => void;
}

const FILTER_KEYS: (keyof BrainFilterFlags)[] = ['notes', 'checklists', 'tags', 'ghosts', 'suggestions', 'orphans'];

export default function BrainToolbar({
  prefs,
  focusId,
  scopeLocal,
  nodes,
  onChangePrefs,
  onSearchPick,
  onDimensionChange,
  onScopeLocalChange,
}: Props) {
  const [query, setQuery] = useState('');
  const suggestions = useMemo(() => searchNodes(nodes, query), [nodes, query]);

  const toggleFilter = (key: keyof BrainFilterFlags) => {
    onChangePrefs({ filters: { ...prefs.filters, [key]: !prefs.filters[key] } });
  };

  return (
    <div className="brain-toolbar" role="toolbar" aria-label="Brain controls">
      <div className="brain-search">
        <input
          type="text"
          placeholder="Search nodes…"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && suggestions[0]) {
              onSearchPick(suggestions[0].id);
              setQuery('');
            }
          }}
        />
        {query.trim() && suggestions.length > 0 && (
          <ul className="brain-search-suggestions" role="listbox">
            {suggestions.map((node) => (
              <li key={node.id} role="option">
                <button onClick={() => { onSearchPick(node.id); setQuery(''); }}>
                  {node.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="brain-dimensions" role="group" aria-label="Dimension">
        <button
          aria-pressed={prefs.dimension === '2d'}
          onClick={() => onDimensionChange('2d')}
        >
          2D
        </button>
        <button
          aria-pressed={prefs.dimension === '3d'}
          onClick={() => onDimensionChange('3d')}
          disabled
        >
          3D
        </button>
      </div>

      {focusId && (
        <div className="brain-scope">
          <label>
            <input
              type="checkbox"
              checked={scopeLocal}
              onChange={() => onScopeLocalChange(!scopeLocal)}
            />
            Local
          </label>
          <input
            type="range"
            min={1}
            max={3}
            data-testid="depth-slider"
            value={prefs.depth}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChangePrefs({ depth: parseInt(e.target.value, 10) })}
            aria-label="Depth"
          />
        </div>
      )}

      <div className="brain-filters" role="group" aria-label="Filters">
        {FILTER_KEYS.map((key) => (
          <button
            key={key}
            aria-pressed={prefs.filters[key]}
            onClick={() => toggleFilter(key)}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="brain-colour">
        <label>
          Colour
          <select
            value={prefs.colourMode}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChangePrefs({ colourMode: e.target.value as 'type' | 'category' })}
          >
            <option value="type">type</option>
            <option value="category">category</option>
          </select>
        </label>
      </div>
    </div>
  );
}
