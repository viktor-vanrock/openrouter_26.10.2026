import { useEffect } from 'react';
import { APP_NAME } from '~/utils/brand';

function useDocumentTitle() {
  useEffect(() => {
    document.title = APP_NAME;
  }, []);
}

export default useDocumentTitle;
