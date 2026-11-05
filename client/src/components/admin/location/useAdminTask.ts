import { useEffect, useRef, useState } from 'react';
import { message } from '../../../location/api';

export function useAdminTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      return await action();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    busy,
    isBusy: () => lock.current,
    error,
    notice,
    setError,
    setNotice,
    run,
  };
}
