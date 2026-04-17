'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ChevronDown, Check } from 'lucide-react';

interface Sprint {
  id: number;
  name: string;
  status: string;
}

interface MultiSprintFilterProps {
  sprints: Sprint[];
  selected: number[];
  onChange: (ids: number[]) => void;
  className?: string;
}

export function MultiSprintFilter({ sprints, selected, onChange, className = '' }: MultiSprintFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus search input when opened
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  const toggle = useCallback((id: number) => {
    if (selected.includes(id)) {
      onChange(selected.filter(s => s !== id));
    } else {
      onChange([...selected, id]);
    }
  }, [selected, onChange]);

  const clearAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  const removeOne = useCallback((e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    onChange(selected.filter(s => s !== id));
  }, [selected, onChange]);

  const filtered = search.trim()
    ? sprints.filter(s => s.name.toLowerCase().includes(search.trim().toLowerCase()))
    : sprints;

  const selectedSprints = sprints.filter(s => selected.includes(s.id));

  // Determine button label
  let buttonLabel: React.ReactNode;
  if (selected.length === 0) {
    buttonLabel = <span className="text-slate-400">All sprints</span>;
  } else if (selected.length <= 2) {
    buttonLabel = (
      <span className="flex items-center gap-1 min-w-0 overflow-hidden">
        {selectedSprints.map(s => (
          <span
            key={s.id}
            className="inline-flex items-center gap-0.5 bg-cyan-900/50 text-cyan-300 border border-cyan-700/50 rounded px-1.5 py-0.5 text-xs whitespace-nowrap max-w-[120px] overflow-hidden text-ellipsis"
          >
            {s.name}
            <button
              type="button"
              onClick={(e) => removeOne(e, s.id)}
              className="hover:text-white transition-colors ml-0.5 flex-shrink-0"
              aria-label={`Remove ${s.name}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </span>
    );
  } else {
    buttonLabel = (
      <span className="text-cyan-300">
        {selected.length} sprints selected
      </span>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between gap-1 bg-slate-800 border rounded-lg px-3 py-1.5 md:py-2 text-sm transition-colors min-h-[36px] ${
          selected.length > 0
            ? 'border-cyan-600/50'
            : 'border-slate-600'
        } focus:outline-none focus:border-amber-400`}
      >
        <span className="flex-1 min-w-0 text-left truncate flex items-center gap-1">
          {buttonLabel}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-slate-400 hover:text-white transition-colors p-0.5"
              aria-label="Clear sprint filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[220px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl overflow-hidden">
          {/* Search input for long sprint lists */}
          {sprints.length > 5 && (
            <div className="p-2 border-b border-slate-700">
              <input
                ref={searchRef}
                type="text"
                placeholder="Search sprints…"
                className="w-full bg-slate-900 border border-slate-600 rounded px-2.5 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-amber-400"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}

          {/* Sprint list */}
          <div className="max-h-[240px] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-500 italic">No sprints found</div>
            ) : (
              filtered.map(sprint => {
                const isSelected = selected.includes(sprint.id);
                return (
                  <button
                    key={sprint.id}
                    type="button"
                    onClick={() => toggle(sprint.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      isSelected
                        ? 'bg-cyan-900/30 text-cyan-200'
                        : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                    }`}
                  >
                    <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'bg-cyan-600 border-cyan-500'
                        : 'border-slate-500 bg-transparent'
                    }`}>
                      {isSelected && <Check className="w-3 h-3 text-white" />}
                    </span>
                    <span className="truncate flex-1">{sprint.name}</span>
                    <span className="text-[10px] text-slate-500 flex-shrink-0">{sprint.status}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer with clear action */}
          {selected.length > 0 && (
            <div className="border-t border-slate-700 px-3 py-2">
              <button
                type="button"
                onClick={clearAll}
                className="text-xs text-slate-400 hover:text-white transition-colors"
              >
                Clear all ({selected.length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
