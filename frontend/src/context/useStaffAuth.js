import { useContext } from 'react';

import { StaffAuthContext } from './staffAuthContext.js';

export function useStaffAuth() {
  const ctx = useContext(StaffAuthContext);
  if (!ctx) {
    throw new Error('useStaffAuth must be used within a StaffAuthProvider');
  }
  return ctx;
}
