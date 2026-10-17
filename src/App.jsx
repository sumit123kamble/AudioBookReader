import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import './App.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const DB_NAME = 'audiora-reader';
const STORE_NAME = 'documents';

function makeId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/*
 * Split the source text into sentences while preserving their
 * original positions. Those positions let the reader highlight
 * the correct words in the displayed text.
 */
function getSentenceSegments(source) {
  const result = [];
  const regex = /[^.!?。！？]+[.!?。！？]*\s*/g;
  let match;

  while ((match = regex.exec(source)) !== null) {
    const raw = match[0];
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const sentence = raw.trim();

    if (!sentence) continue;

    const start = match.index + leadingWhitespace;

    result.push({
      text: sentence,
      start,
      end: start + sentence.length,
    });
  }

  return result;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllDocuments() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      resolve(
        request.result.sort(
          (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
        )
      );
    };

    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function saveDocument(document) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');

    transaction.objectStore(STORE_NAME).put(document);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };

    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function deleteDocument(id) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');

    transaction.objectStore(STORE_NAME).delete(id);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function formatDate(timestamp) {
  if (!timestamp) return 'Recently saved';

  return new Date(timestamp).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getProgress(index, total) {
  if (!total) return 0;
  return Math.min(100, Math.round(((index + 1) / total) * 100));
}

function App() {
  const [title, setTitle] = useState('Untitled document');
  const [text, setText] = useState('');
  const [documents, setDocuments] = useState([]);
  const [currentId, setCurrentId] = useState(makeId());

  const [voices, setVoices] = useState([]);
  const [voiceName, setVoiceName] = useState('');
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [volume, setVolume] = useState(1);

  const [sentenceIndex, setSentenceIndex] = useState(0);
  const [activeWord, setActiveWord] = useState(null);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);

  const [status, setStatus] = useState('Ready to read');
  const [error, setError] = useState('');
  const [isImportingPdf, setIsImportingPdf] = useState(false);

  const pdfInputRef = useRef(null);
  const textRef = useRef(null);
  const activeSentenceRef = useRef(null);

  const runIdRef = useRef(0);
  const speakingRef = useRef(false);
  const pausedRef = useRef(false);
  const timerRef = useRef(null);
  const settingsRef = useRef({});
  const sentenceIndexRef = useRef(0);
  const currentIdRef = useRef(currentId);

  const sentences = getSentenceSegments(text);
  const wordCount = text.trim()
    ? text.trim().split(/\s+/).length
    : 0;

  const characterCount = text.length;
  const progress = getProgress(sentenceIndex, sentences.length);

  const isHistoryPage =
    new URLSearchParams(window.location.search).get('view') === 'history';

  const requestedDocumentId =
    new URLSearchParams(window.location.search).get('doc');

  useEffect(() => {
    settingsRef.current = {
      voiceName,
      rate,
      pitch,
      volume,
    };
  }, [voiceName, rate, pitch, volume]);

  useEffect(() => {
    sentenceIndexRef.current = sentenceIndex;
  }, [sentenceIndex]);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  const refreshDocuments = useCallback(async () => {
    try {
      const savedDocuments = await getAllDocuments();
      setDocuments(savedDocuments);
    } catch (err) {
      console.error('Could not load saved documents:', err);
    }
  }, []);

  useEffect(() => {
    refreshDocuments();

    if (!('speechSynthesis' in window)) {
      setError(
        'Speech synthesis is not supported by this browser. Try a recent version of Chrome or Edge.'
      );
      return;
    }

    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices();

      setVoices(availableVoices);

      if (availableVoices.length > 0) {
        setVoiceName((previous) => {
          if (
            previous &&
            availableVoices.some((voice) => voice.name === previous)
          ) {
            return previous;
          }

          const preferredVoice = availableVoices.find(
            (voice) => voice.lang?.toLowerCase().startsWith('en')
          );

          return (preferredVoice || availableVoices[0]).name;
        });
      }
    };

    loadVoices();
    window.speechSynthesis.addEventListener?.(
      'voiceschanged',
      loadVoices
    );

    // Compatibility with browsers that expose the event as a property.
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.removeEventListener?.(
        'voiceschanged',
        loadVoices
      );

      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [refreshDocuments]);

  /*
   * Open a saved document when ?doc=<id> is present.
   */
  useEffect(() => {
    if (!requestedDocumentId) return;

    let cancelled = false;

    async function loadDocument() {
      try {
        const savedDocuments = await getAllDocuments();

        if (cancelled) return;

        setDocuments(savedDocuments);

        const document = savedDocuments.find(
          (item) => item.id === requestedDocumentId
        );

        if (!document) {
          setError('That saved document could not be found.');
          return;
        }

        stopSpeech();

        setTitle(document.title || 'Untitled document');
        setText(document.text || '');
        setCurrentId(document.id);
        setSentenceIndex(document.progress || 0);
        setActiveWord(null);
        setStatus('Document loaded');
        setError('');
      } catch (err) {
        if (!cancelled) {
          setError('Could not open the saved document.');
        }
      }
    }

    loadDocument();

    return () => {
      cancelled = true;
    };

    // Loading should happen when the URL document ID changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDocumentId]);

  /*
   * Autosave the current document to IndexedDB.
   */
  useEffect(() => {
    if (isHistoryPage || requestedDocumentId) return;

    const timeout = window.setTimeout(async () => {
      try {
        await saveDocument({
          id: currentId,
          title: title.trim() || 'Untitled document',
          text,
          progress: sentenceIndex,
          updatedAt: Date.now(),
        });

        await refreshDocuments();
      } catch (err) {
        console.error('Could not save document:', err);
      }
    }, 800);

    return () => window.clearTimeout(timeout);
  }, [
    currentId,
    title,
    text,
    sentenceIndex,
    isHistoryPage,
    requestedDocumentId,
    refreshDocuments,
  ]);

  /*
   * Keep the active sentence visible as speech advances.
   */
  useEffect(() => {
    if (!speaking && !paused) return;

    activeSentenceRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [sentenceIndex, speaking, paused]);

  const stopSpeech = useCallback(() => {
    runIdRef.current += 1;

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    speakingRef.current = false;
    pausedRef.current = false;

    setSpeaking(false);
    setPaused(false);
    setActiveWord(null);
  }, []);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;

      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }

      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  /*
   * Speak from a sentence and character offset.
   *
   * The first sentence can start at a selected word. Subsequent
   * sentences are read normally from their beginning.
   */
  const speakFrom = useCallback(
    (startIndex, startOffset = 0) => {
      if (!('speechSynthesis' in window)) {
        setError('Speech synthesis is not available in this browser.');
        return;
      }

      if (!sentences.length) {
        setError('Add some text before starting playback.');
        return;
      }

      const safeStart = Math.max(
        0,
        Math.min(startIndex, sentences.length - 1)
      );

      stopSpeech();

      const runId = runIdRef.current;
      const sentenceSnapshot = sentences;
      const settings = settingsRef.current;

      speakingRef.current = true;
      pausedRef.current = false;

      setSpeaking(true);
      setPaused(false);
      setError('');
      setSentenceIndex(safeStart);
      setActiveWord(null);
      setStatus('Reading');

      const speakNext = (index, offset = 0) => {
        if (runId !== runIdRef.current) return;

        if (index >= sentenceSnapshot.length) {
          speakingRef.current = false;
          pausedRef.current = false;

          setSpeaking(false);
          setPaused(false);
          setActiveWord(null);
          setStatus('Finished reading');
          setSentenceIndex(Math.max(0, sentenceSnapshot.length - 1));

          return;
        }

        const segment = sentenceSnapshot[index];
        const safeOffset = Math.max(
          0,
          Math.min(offset, segment.text.length)
        );

        const spokenText = segment.text.slice(safeOffset);

        if (!spokenText.trim()) {
          speakNext(index + 1, 0);
          return;
        }

        setSentenceIndex(index);
        setActiveWord(null);

        const utterance = new SpeechSynthesisUtterance(spokenText);

        const selectedVoice = voices.find(
          (voice) => voice.name === settings.voiceName
        );

        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.rate = Number(settings.rate) || 1;
        utterance.pitch = Number(settings.pitch) || 1;
        utterance.volume = Number(settings.volume) || 0;

        /*
         * The event character index is relative to spokenText,
         * so add safeOffset to locate the word in the full sentence.
         */
        utterance.onboundary = (event) => {
          if (runId !== runIdRef.current) return;
          if (event.name !== 'word') return;

          const wordStart = safeOffset + event.charIndex;

          let wordEnd;

          if (event.charLength > 0) {
            wordEnd = wordStart + event.charLength;
          } else {
            const rest = segment.text.slice(wordStart);
            const match = rest.match(/^\S+/);
            wordEnd = wordStart + (match?.[0].length || 1);
          }

          setActiveWord({
            sentenceIndex: index,
            start: wordStart,
            end: wordEnd,
          });
        };

        utterance.onend = () => {
          if (runId !== runIdRef.current) return;

          setActiveWord(null);
          setSentenceIndex(index + 1);

          speakNext(index + 1, 0);
        };

        utterance.onerror = (event) => {
          if (runId !== runIdRef.current) return;

          if (
            event.error === 'canceled' ||
            event.error === 'interrupted'
          ) {
            return;
          }

          speakingRef.current = false;
          pausedRef.current = false;

          setSpeaking(false);
          setPaused(false);
          setActiveWord(null);
          setStatus('Playback error');
          setError(`Speech playback failed: ${event.error || 'unknown error'}`);
        };

        window.speechSynthesis.speak(utterance);
      };

      speakNext(safeStart, startOffset);
    },
    [sentences, voices, stopSpeech]
  );

  /*
   * Read from the selected text in the editor. If a word or range
   * is selected, start at the beginning of that word.
   * Otherwise, use the cursor position.
   */
  const handlePlay = () => {
    if (!('speechSynthesis' in window)) {
      setError('Speech synthesis is not supported in this browser.');
      return;
    }

    if (pausedRef.current) {
      window.speechSynthesis.resume();

      pausedRef.current = false;
      setPaused(false);
      setStatus('Reading');

      return;
    }

    if (speakingRef.current) {
      window.speechSynthesis.pause();

      pausedRef.current = true;
      setPaused(true);
      setStatus('Paused');

      return;
    }

    if (!sentences.length) {
      setError('Add some text before starting playback.');
      return;
    }

    const editor = textRef.current;

    if (editor) {
      const selectionStart = Math.min(
        editor.selectionStart,
        editor.selectionEnd
      );

      const segmentIndex = sentences.findIndex(
        (segment) =>
          selectionStart >= segment.start &&
          selectionStart <= segment.end
      );

      if (segmentIndex !== -1) {
        const segment = sentences[segmentIndex];
        let offset = Math.max(0, selectionStart - segment.start);

        // Skip leading whitespace so playback starts on the word.
        while (
          offset < segment.text.length &&
          /\s/.test(segment.text[offset])
        ) {
          offset += 1;
        }

        // If the cursor is in the middle of a word, rewind to its start.
        while (
          offset > 0 &&
          !/\s/.test(segment.text[offset - 1])
        ) {
          offset -= 1;
        }

        speakFrom(segmentIndex, offset);
        return;
      }
    }

    const fallbackIndex = Math.min(
      sentenceIndex,
      Math.max(0, sentences.length - 1)
    );

    speakFrom(fallbackIndex, 0);
  };

  const handleStop = () => {
    stopSpeech();
    setStatus('Stopped');
  };

  const handlePrevious = () => {
    if (!sentences.length) return;

    const target = Math.max(0, sentenceIndex - 1);
    speakFrom(target, 0);
  };

  const handleNext = () => {
    if (!sentences.length) return;

    const target = Math.min(
      sentences.length - 1,
      sentenceIndex + 1
    );

    speakFrom(target, 0);
  };

  const handleNewDocument = () => {
    stopSpeech();

    const newId = makeId();

    setCurrentId(newId);
    setTitle('Untitled document');
    setText('');
    setSentenceIndex(0);
    setActiveWord(null);
    setStatus('Ready to read');
    setError('');

    window.history.pushState({}, '', window.location.pathname);
  };

  const handleOpenDocument = (document) => {
    stopSpeech();

    setCurrentId(document.id);
    setTitle(document.title || 'Untitled document');
    setText(document.text || '');
    setSentenceIndex(document.progress || 0);
    setActiveWord(null);
    setStatus('Document loaded');
    setError('');

    window.history.pushState(
      {},
      '',
      `${window.location.pathname}?doc=${encodeURIComponent(document.id)}`
    );

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteDocument = async (id) => {
    if (!window.confirm('Delete this saved document?')) return;

    try {
      if (id === currentId) {
        stopSpeech();
      }

      await deleteDocument(id);
      await refreshDocuments();

      if (id === currentId) {
        const newId = makeId();
        setCurrentId(newId);
        setTitle('Untitled document');
        setText('');
        setSentenceIndex(0);
        setActiveWord(null);

        window.history.pushState({}, '', window.location.pathname);
      }
    } catch (err) {
      setError('Could not delete the saved document.');
    }
  };

  const handleImportPdf = async (event) => {
    const file = event.target.files?.[0];

    // Allow importing the same file again later.
    event.target.value = '';

    if (!file) return;

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.');
      return;
    }

    setIsImportingPdf(true);
    setError('');

    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(buffer),
      }).promise;

      const pages = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();

        const pageText = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]+/g, ' ')
          .trim();

        if (pageText) {
          pages.push(pageText);
        }
      }

      const extractedText = pages.join('\n\n');

      if (!extractedText.trim()) {
        setError(
          'No selectable text was found in this PDF. Scanned or image-only PDFs are not supported.'
        );
        return;
      }

      stopSpeech();

      setText(extractedText);
      setTitle(file.name.replace(/\.pdf$/i, '') || 'Imported PDF');
      setCurrentId(makeId());
      setSentenceIndex(0);
      setActiveWord(null);
      setStatus('PDF imported');

      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('PDF import failed:', err);
      setError('Could not read this PDF. Please check that the file is valid.');
    } finally {
      setIsImportingPdf(false);
    }
  };

  const handleSentenceClick = (index) => {
    if (index < 0 || index >= sentences.length) return;
    speakFrom(index, 0);
  };

  /*
   * Render the sentence in pieces so only the active spoken word
   * receives the word-highlight class.
   */
  const renderSentenceText = (segment, index) => {
    const word =
      activeWord?.sentenceIndex === index ? activeWord : null;

    if (!word) return segment.text;

    const start = Math.max(0, Math.min(word.start, segment.text.length));
    const end = Math.max(start, Math.min(word.end, segment.text.length));

    if (start === end) return segment.text;

    return (
      <>
        {segment.text.slice(0, start)}
        <span className="read-word">
          {segment.text.slice(start, end)}
        </span>
        {segment.text.slice(end)}
      </>
    );
  };

  if (isHistoryPage) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">♫</span>
            Audiora
          </div>

          <div className="top-actions">
            <button
              className="secondary-button"
              onClick={() => {
                window.location.href = window.location.pathname;
              }}
            >
              ← Back to reader
            </button>

            <button
              className="primary-button"
              onClick={() => {
                window.location.href = window.location.pathname;
              }}
            >
              + New document
            </button>
          </div>
        </header>

        <main className="history-content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR LIBRARY</p>
              <h1>Reading history</h1>
              <p className="muted">
                Your documents are saved locally in this browser.
              </p>
            </div>
          </div>

          {documents.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">▤</span>
              <h2>No saved documents yet</h2>
              <p>Import a PDF or write some text to start your library.</p>
            </div>
          ) : (
            <div className="history-list">
              {documents.map((document) => {
                const documentSentences = getSentenceSegments(
                  document.text || ''
                );

                const documentProgress = getProgress(
                  document.progress || 0,
                  documentSentences.length
                );

                return (
                  <article className="history-card" key={document.id}>
                    <button
                      className="history-open"
                      onClick={() => handleOpenDocument(document)}
                    >
                      <span className="document-icon">▤</span>

                      <span className="history-details">
                        <strong>
                          {document.title || 'Untitled document'}
                        </strong>

                        <span className="muted">
                          {formatDate(document.updatedAt)} ·{' '}
                          {documentSentences.length} sentences
                        </span>

                        <span className="progress-track">
                          <span
                            style={{ width: `${documentProgress}%` }}
                          />
                        </span>
                      </span>
                    </button>

                    <button
                      className="icon-button delete-button"
                      aria-label={`Delete ${document.title || 'document'}`}
                      title="Delete document"
                      onClick={() => handleDeleteDocument(document.id)}
                    >
                      ×
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">♫</span>
          Audiora
        </div>

        <div className="top-actions">
          <span className="save-status">
            <span className="status-dot" />
            Saved locally
          </span>

          <button
            className="secondary-button"
            onClick={() => {
              window.location.href = `${window.location.pathname}?view=history`;
            }}
          >
            ▤ History
          </button>

          <button className="primary-button" onClick={handleNewDocument}>
            + New document
          </button>
        </div>
      </header>

      <main>
        <section className="welcome">
          <div>
            <p className="eyebrow">YOUR PERSONAL READING SPACE</p>
            <h1>Listen to your words.</h1>
            <p className="muted">
              Turn documents into a listening experience, at your pace.
            </p>
          </div>

          <div className="welcome-icon">♫</div>
        </section>

        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}

        <div className="workspace">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">YOUR DOCUMENT</p>
                <h2>Reading workspace</h2>
              </div>

              <span className="word-count">
                {wordCount.toLocaleString()} words
              </span>
            </div>

            <label className="field-label" htmlFor="document-title">
              Document title
            </label>

            <input
              id="document-title"
              className="title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Give your document a title"
            />

            <div className="pdf-upload-row">
              <label className="field-label" htmlFor="reading-text">
                Document text
              </label>

              <button
                className="secondary-button"
                onClick={() => pdfInputRef.current?.click()}
                disabled={isImportingPdf}
              >
                {isImportingPdf ? 'Importing PDF…' : '↑ Import PDF'}
              </button>

              <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf,application/pdf"
                hidden
                onChange={handleImportPdf}
              />
            </div>

            <textarea
              id="reading-text"
              ref={textRef}
              className="reading-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSentenceIndex(0);
                setActiveWord(null);
              }}
              placeholder="Paste or type your text here, or import a text-based PDF. Select a word and press Play to start reading from that point."
              spellCheck="false"
            />

            <div className="editor-footer">
              <span className="muted">
                {characterCount.toLocaleString()} characters
              </span>

              <button
                className="text-button"
                onClick={() => {
                  stopSpeech();
                  setText('');
                  setSentenceIndex(0);
                  setActiveWord(null);
                  setStatus('Ready to read');
                }}
                disabled={!text}
              >
                Clear text
              </button>
            </div>

            <section className="playback-card">
              <div className="playback-title">
                <div className="play-symbol">♫</div>

                <div>
                  <strong>
                    {speaking
                      ? paused
                        ? 'Playback paused'
                        : 'Now playing'
                      : status}
                  </strong>

                  <p className="muted">
                    {sentences.length
                      ? `Sentence ${Math.min(
                          sentenceIndex + 1,
                          sentences.length
                        )} of ${sentences.length}`
                      : 'Your reading session will appear here'}
                  </p>
                </div>
              </div>

              <div className="progress-track playback-progress">
                <span style={{ width: `${progress}%` }} />
              </div>

              <div className="player-controls">
                <button
                  className="icon-button"
                  onClick={handlePrevious}
                  disabled={!sentences.length}
                  aria-label="Previous sentence"
                  title="Previous sentence"
                >
                  «
                </button>

                <button
                  className="play-button"
                  onClick={handlePlay}
                  disabled={!sentences.length}
                  aria-label={
                    paused ? 'Resume reading' : speaking ? 'Pause reading' : 'Start reading'
                  }
                  title={
                    paused ? 'Resume' : speaking ? 'Pause' : 'Play'
                  }
                >
                  {paused ? '▶' : speaking ? 'Ⅱ' : '▶'}
                </button>

                <button
                  className="icon-button"
                  onClick={handleStop}
                  disabled={!speaking && !paused}
                  aria-label="Stop reading"
                  title="Stop"
                >
                  ■
                </button>

                <button
                  className="icon-button"
                  onClick={handleNext}
                  disabled={!sentences.length}
                  aria-label="Next sentence"
                  title="Next sentence"
                >
                  »
                </button>
              </div>

              <p className="player-note">
                Select a word in the editor to start from that word.
                Word highlighting depends on your browser's speech support.
              </p>
            </section>

            {/* Read-along view: the textarea stays editable above. */}
            <section className="read-along">
              <div className="read-along-heading">
                <div>
                  <p className="eyebrow">FOLLOW ALONG</p>
                  <h2>Live reading</h2>
                </div>

                <span className="read-along-status">
                  {speaking ? (paused ? 'Paused' : 'Reading') : 'Preview'}
                </span>
              </div>

              {!text.trim() ? (
                <p className="read-along-empty">
                  Your text will appear here. Start reading to follow along.
                </p>
              ) : (
                <div className="read-along-text">
                  {sentences.map((segment, index) => {
                    const isActive =
                      index === sentenceIndex &&
                      (speaking || paused);

                    return (
                      <span
                        key={`${segment.start}-${index}`}
                        ref={isActive ? activeSentenceRef : null}
                        className={[
                          'read-sentence',
                          isActive ? 'is-active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        role="button"
                        tabIndex={0}
                        title={`Start reading from sentence ${index + 1}`}
                        onClick={() => handleSentenceClick(index)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleSentenceClick(index);
                          }
                        }}
                      >
                        {renderSentenceText(segment, index)}
                        {' '}
                      </span>
                    );
                  })}
                </div>
              )}

              <p className="read-along-hint">
                Tip: click any sentence here to begin reading from it.
              </p>
            </section>
          </section>

          <aside className="panel settings-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">PERSONALIZE</p>
                <h2>Voice settings</h2>
              </div>

              <div className="settings-icon">⚙</div>
            </div>

            <label className="field-label" htmlFor="voice-select">
              Voice
            </label>

            <select
              id="voice-select"
              className="select-input"
              value={voiceName}
              onChange={(event) => setVoiceName(event.target.value)}
            >
              {voices.length === 0 && (
                <option value="">Loading voices…</option>
              )}

              {voices.map((voice) => (
                <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>

            <p className="help-text">
              Available voices depend on your browser and operating system.
            </p>

            <div className="setting-block">
              <div className="setting-label">
                <label htmlFor="rate-range">Reading speed</label>
                <strong>{Number(rate).toFixed(1)}×</strong>
              </div>

              <input
                id="rate-range"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={rate}
                onChange={(event) => setRate(Number(event.target.value))}
              />

              <div className="range-labels">
                <span>Slow</span>
                <span>Fast</span>
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">
                <label htmlFor="pitch-range">Voice pitch</label>
                <strong>{Number(pitch).toFixed(1)}</strong>
              </div>

              <input
                id="pitch-range"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={pitch}
                onChange={(event) => setPitch(Number(event.target.value))}
              />

              <div className="range-labels">
                <span>Low</span>
                <span>High</span>
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-label">
                <label htmlFor="volume-range">Volume</label>
                <strong>{Math.round(volume * 100)}%</strong>
              </div>

              <input
                id="volume-range"
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />

              <div className="range-labels">
                <span>Quiet</span>
                <span>Loud</span>
              </div>
            </div>

            <button
              className="secondary-button full-width"
              onClick={() => {
                setRate(1);
                setPitch(1);
                setVolume(1);
              }}
            >
              Reset voice settings
            </button>

            <div className="privacy-note">
              <span>✓</span>
              <div>
                <strong>Your privacy matters</strong>
                <p>
                  Your documents are saved in your browser's local storage
                  database. This reader does not require an account.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>

      <footer className="app-footer">
        <span>Audiora · Your personal reading space</span>
        <span>Read at your own pace.</span>
      </footer>
    </div>
  );
}

export default App;