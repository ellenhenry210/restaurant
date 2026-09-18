import axios from 'axios';

// VITE_API_BASE_URL has no /v1 suffix (frontend/.env.example) — appended
// here, once, rather than repeating it in every call site.
export const apiClient = axios.create({
  baseURL: `${import.meta.env.VITE_API_BASE_URL}/v1`,
});
