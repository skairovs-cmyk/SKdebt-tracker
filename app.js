import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  getDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  onSnapshot 
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// --- STATE MANAGEMENT ---
const state = {
  db: null,
  auth: null,
  currentUser: null,
  records: [],
  customColumns: [],
  incomes: [],
  storage: null,
  currentProofRecordId: null,
  currentProofIncomeId: null,
  recordsUnsubscribe: null,
  settingsUnsubscribe: null,
  incomesUnsubscribe: null,
  sorting: {
    records: { key: 'name', direction: 'asc' },
    incomes: { key: 'name', direction: 'asc' },
    history: { key: 'date', direction: 'desc' }
  }
};

// --- MODAL UTILITIES ---
window.openModal = function(id) {
  document.getElementById(id).classList.remove('hidden');
};

window.closeModal = function(id) {
  document.getElementById(id).classList.add('hidden');
};

function icon(name) {
  return `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

const DEFAULT_DESC_SORT_KEYS = new Set(['amount', 'balance', 'initialAmount', 'date', 'takenDate', 'closedDate', 'proof']);
const RECORD_TYPE_LABELS = {
  'my-debt': 'Мой долг',
  'debt-to-me': 'Долг мне',
  'regular': 'Регулярное обязательство'
};
const STATUS_ORDER = { 'Active': 0, 'Closed': 1 };
const INCOME_FREQUENCY_ORDER = { 'monthly': 0, 'weekly': 1, 'once': 2 };

function getDefaultSortDirection(key) {
  return DEFAULT_DESC_SORT_KEYS.has(key) ? 'desc' : 'asc';
}

function getRecordTypeDisplayLabel(record) {
  const customLabel = String(record?.typeLabel ?? record?.type ?? '').trim();
  if (customLabel) {
    return customLabel;
  }

  return RECORD_TYPE_LABELS[record?.type] || '';
}

function normalizeTextSort(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU');
}

function parseDateSort(value) {
  if (!value) {
    return { empty: true, value: 0 };
  }

  const ts = Date.parse(`${value}T00:00:00`);
  if (Number.isNaN(ts)) {
    return { empty: true, value: 0 };
  }

  return { empty: false, value: ts };
}

function compareSortValues(left, right, direction) {
  if (left.empty && right.empty) return 0;
  if (left.empty) return 1;
  if (right.empty) return -1;

  if (left.value < right.value) return direction === 'asc' ? -1 : 1;
  if (left.value > right.value) return direction === 'asc' ? 1 : -1;
  return 0;
}

function getRecordColumnType(key) {
  if (key === 'initialAmount' || key === 'balance') return 'number';
  if (key === 'takenDate' || key === 'closedDate') return 'date';
  if (key === 'type') return 'record-type';
  if (key === 'status') return 'status';
  const custom = state.customColumns.find((col) => col.key === key);
  return custom ? custom.type : 'text';
}

function getRecordSortValue(record, key) {
  if (key === 'name') return { empty: !record.name, value: normalizeTextSort(record.name) };
  if (key === 'type') {
    return { empty: !getRecordTypeDisplayLabel(record), value: normalizeTextSort(getRecordTypeDisplayLabel(record)) };
  }
  if (key === 'initialAmount') {
    return { empty: record.initialAmount === undefined || record.initialAmount === null || record.initialAmount === '', value: Number(record.initialAmount) || 0 };
  }
  if (key === 'balance') {
    return { empty: record.balance === undefined || record.balance === null || record.balance === '', value: Number(record.balance) || 0 };
  }
  if (key === 'status') {
    return { empty: false, value: STATUS_ORDER[record.status] ?? 99 };
  }
  if (key === 'takenDate' || key === 'closedDate') {
    return parseDateSort(record[key]);
  }

  const col = state.customColumns.find((item) => item.key === key);
  if (col) {
    const value = record[key];
    if (value === undefined || value === null || value === '') {
      return { empty: true, value: 0 };
    }
    if (col.type === 'number') return { empty: false, value: Number(value) || 0 };
    if (col.type === 'date') return parseDateSort(value);
    return { empty: false, value: normalizeTextSort(value) };
  }

  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return { empty: true, value: '' };
  }
  return { empty: false, value: normalizeTextSort(value) };
}

function sortRecords(records) {
  const { key, direction } = state.sorting.records;
  return [...records].sort((a, b) => compareSortValues(getRecordSortValue(a, key), getRecordSortValue(b, key), direction));
}

function getIncomeSortValue(income, key) {
  if (key === 'name') return { empty: !income.name, value: normalizeTextSort(income.name) };
  if (key === 'amount') return { empty: income.amount === undefined || income.amount === null || income.amount === '', value: Number(income.amount) || 0 };
  if (key === 'frequency') return { empty: false, value: INCOME_FREQUENCY_ORDER[income.frequency] ?? 99 };
  if (key === 'date') return parseDateSort(income.date);

  const value = income[key];
  if (value === undefined || value === null || value === '') {
    return { empty: true, value: '' };
  }
  return { empty: false, value: normalizeTextSort(value) };
}

function sortIncomes(incomes) {
  const { key, direction } = state.sorting.incomes;
  return [...incomes].sort((a, b) => compareSortValues(getIncomeSortValue(a, key), getIncomeSortValue(b, key), direction));
}

function getTransactionSortValue(tx, key) {
  if (key === 'type') return { empty: !tx.category, value: normalizeTextSort(tx.category) };
  if (key === 'date') return parseDateSort(tx.date);
  if (key === 'description') return { empty: !tx.description, value: normalizeTextSort(tx.description) };
  if (key === 'category') return { empty: !tx.category, value: normalizeTextSort(tx.category) };
  if (key === 'amount') return { empty: tx.amount === undefined || tx.amount === null || tx.amount === '', value: Number(tx.amount) || 0 };
  if (key === 'proof') return { empty: false, value: tx.proofUrl ? 1 : 0 };
  return { empty: true, value: '' };
}

function sortTransactions(transactions) {
  const { key, direction } = state.sorting.history;
  return [...transactions].sort((a, b) => compareSortValues(getTransactionSortValue(a, key), getTransactionSortValue(b, key), direction));
}

function setSort(table, key) {
  const current = state.sorting[table] || { key, direction: 'asc' };
  const direction = current.key === key ? (current.direction === 'asc' ? 'desc' : 'asc') : getDefaultSortDirection(key);
  state.sorting[table] = { key, direction };

  if (table === 'records') {
    renderHeaders();
    renderRecords();
    return;
  }

  if (table === 'incomes') {
    renderIncomesHeaders();
    renderIncomes();
    return;
  }

  if (table === 'history') {
    renderGlobalHistoryHeaders();
    renderGlobalHistory();
    if (!document.getElementById('history-modal').classList.contains('hidden')) {
      renderHistoryModal();
    }
  }
}

function createSortHeaderButton(table, key, label) {
  const button = document.createElement('button');
  button.type = 'button';
  const sortState = state.sorting[table] || {};
  const isActive = sortState.key === key;
  const indicator = isActive ? (sortState.direction === 'asc' ? '↑' : '↓') : '↕';
  button.className = `sort-header${isActive ? ' active' : ''}`;
  button.innerHTML = `<span class="sort-label">${label}</span><span class="sort-indicator">${indicator}</span>`;
  button.setAttribute('aria-label', `Сортировать по столбцу ${label}`);
  button.onclick = () => setSort(table, key);
  return button;
}

function buildSortHeaderCell(table, key, label, options = {}) {
  const th = document.createElement('th');
  th.className = 'sortable-header';

  if (options.width) {
    th.style.width = options.width;
  }
  if (options.align) {
    th.style.textAlign = options.align;
  }

  if (options.customColumn) {
    th.style.position = 'relative';
    th.style.paddingRight = '2.25rem';
  }

  th.appendChild(createSortHeaderButton(table, key, label));
  return th;
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupUIEventListeners();
  renderHeaders();
  renderIncomesHeaders();
  renderGlobalHistoryHeaders();
  renderHistoryModalHeaders();
});

const defaultFirebaseConfig = {
  apiKey: "AIzaSyADMw-39J5ClQzFkOGJin0weNRONU5ot98",
  authDomain: "skdebt-tracker.firebaseapp.com",
  projectId: "skdebt-tracker",
  storageBucket: "skdebt-tracker.appspot.com",
  messagingSenderId: "736622488551",
  appId: "1:736622488551:web:f3ca42c06a4a415f94b42",
  measurementId: "G-DXJ9G67SD5"
};

function initApp() {
  let savedConfig = localStorage.getItem('firebase_config');
  
  if (!savedConfig) {
    savedConfig = JSON.stringify(defaultFirebaseConfig);
    localStorage.setItem('firebase_config', savedConfig);
  }

  try {
    const firebaseConfig = JSON.parse(savedConfig);
    // Detect legacy bucket name that causes CORS errors and force a refresh
    if (firebaseConfig.storageBucket && firebaseConfig.storageBucket.endsWith('.firebasestorage.app')) {
      console.warn('Legacy storageBucket detected, clearing cached config to apply corrected bucket.');
      localStorage.removeItem('firebase_config');
      // Reload the page so the corrected hard‑coded default config is used
      location.reload();
      return; // Prevent further init until reload
    }
    const app = initializeApp(firebaseConfig);
    state.db = getFirestore(app);
    state.auth = getAuth(app);
    state.storage = getStorage(app);
    
    // Auth State Listener
    onAuthStateChanged(state.auth, (user) => {
      if (user) {
        state.currentUser = user;
        document.getElementById('current-user-email').textContent = user.email;
        showScreen('dashboard-screen');
        startRealtimeSync(user.uid);
      } else {
        cleanupUserSession();
        showScreen('auth-screen');
      }
    });
  } catch (error) {
    console.error('Firebase Init Error:', error);
    alert('Ошибка при подключении к Firebase. Конфигурация сброшена. Пожалуйста, введите корректные данные.');
    localStorage.removeItem('firebase_config');
    showScreen('setup-screen');
  }
}

// Switch between screens: 'setup-screen', 'auth-screen', 'dashboard-screen'
function showScreen(screenId) {
  document.getElementById('setup-screen').classList.add('hidden');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.add('hidden');
  
  document.getElementById(screenId).classList.remove('hidden');
}

function cleanupUserSession() {
  state.currentUser = null;
  state.records = [];
  state.customColumns = [];
  state.incomes = [];
  if (state.recordsUnsubscribe) state.recordsUnsubscribe();
  if (state.settingsUnsubscribe) state.settingsUnsubscribe();
  if (state.incomesUnsubscribe) state.incomesUnsubscribe();
  state.recordsUnsubscribe = null;
  state.settingsUnsubscribe = null;
  state.incomesUnsubscribe = null;
}

// --- DATABASE SEEDER FOR USER DEBTS ---
async function seedPersonalDebts(userId) {
  if (localStorage.getItem(`seeded_debts_${userId}`) === 'true') {
    return;
  }
  
  const debtsToSeed = [
    { name: "Artur (Private loan)", type: "my-debt", initialAmount: 1000, balance: 1000, status: "Active", history: [], userId: userId },
    { name: "Kostik K (Private loan)", type: "my-debt", initialAmount: 1000, balance: 1000, status: "Active", history: [], userId: userId },
    { name: "Kostik R (Private loan)", type: "my-debt", initialAmount: 1000, balance: 1000, status: "Active", history: [], userId: userId },
    { name: "Nastya (Nastya Mini-Credit)", type: "my-debt", initialAmount: 500, balance: 500, status: "Active", history: [], userId: userId }
  ];

  try {
    for (const debt of debtsToSeed) {
      debt.createdAt = new Date().toISOString();
      debt.updatedAt = new Date().toISOString();
      await addDoc(collection(state.db, 'records'), debt);
    }
    localStorage.setItem(`seeded_debts_${userId}`, 'true');
    console.log("Successfully seeded personal debts.");
  } catch (err) {
    console.error("Error seeding debts:", err);
  }
}

// --- REAL-TIME SYNC ENGINE ---
function startRealtimeSync(userId) {
  seedPersonalDebts(userId);
  // 1. Sync custom columns settings
  const settingsDocRef = doc(state.db, 'settings', userId);
  state.settingsUnsubscribe = onSnapshot(settingsDocRef, (docSnap) => {
    if (docSnap.exists() && docSnap.data().customColumns) {
      state.customColumns = docSnap.data().customColumns;
    } else {
      state.customColumns = [];
    }
    renderHeaders();
    renderRecords();
  }, (error) => {
    console.error('Error syncing settings:', error);
  });

  // 2. Sync financial records
  const recordsQuery = query(
    collection(state.db, 'records'),
    where('userId', '==', userId)
  );

  state.recordsUnsubscribe = onSnapshot(recordsQuery, (snapshot) => {
    state.records = [];
    snapshot.forEach((doc) => {
      state.records.push({ id: doc.id, ...doc.data() });
    });
    
    // Sort records: Active first, then Closed, then alphabetically by name
    state.records.sort((a, b) => {
      if (a.status === 'Active' && b.status === 'Closed') return -1;
      if (a.status === 'Closed' && b.status === 'Active') return 1;
      return a.name.localeCompare(b.name);
    });

    calculateStats();
    renderRecords();
    renderGlobalHistory();
  }, (error) => {
    console.error('Error syncing records:', error);
  });

  // 3. Sync incomes
  const incomesQuery = query(
    collection(state.db, 'incomes'),
    where('userId', '==', userId)
  );

  state.incomesUnsubscribe = onSnapshot(incomesQuery, (snapshot) => {
    state.incomes = [];
    snapshot.forEach((doc) => {
      state.incomes.push({ id: doc.id, ...doc.data() });
    });

    // Sort incomes: alphabetically by name
    state.incomes.sort((a, b) => a.name.localeCompare(b.name));

    calculateStats();
    renderIncomes();
    renderGlobalHistory();
  }, (error) => {
    console.error('Error syncing incomes:', error);
  });
}

// --- CALCULATE AND UPDATE STATISTICS ---
function calculateStats() {
  let owedToMe = 0; // Total debt to me
  let owedByMe = 0; // Total my debts + regular obligations
  let activeCount = 0;
  let paidThisMonth = 0;

  // For current calendar month calculation
  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; // e.g. "2026-08"

  state.records.forEach((rec) => {
    const balance = Number(rec.balance) || 0;
    
    if (rec.status === 'Active') {
      activeCount++;
      if (rec.type === 'debt-to-me') {
        owedToMe += balance;
      } else {
        // 'my-debt' or 'regular'
        owedByMe += balance;
      }
    }

    // Process history transactions for paid stats
    if (Array.isArray(rec.history)) {
      rec.history.forEach((tx) => {
        if (tx.date && tx.date.startsWith(currentYearMonth)) {
          paidThisMonth += Number(tx.amount) || 0;
        }
      });
    }
  });

  const netBalance = owedToMe - owedByMe;

  // DOM Updates
  const netValEl = document.getElementById('stat-net-balance');
  netValEl.textContent = `${netBalance >= 0 ? '+' : ''}${netBalance.toLocaleString('de-DE')} €`;
  netValEl.className = 'stat-value ' + (netBalance >= 0 ? 'text-success' : 'text-danger');

  document.getElementById('stat-sub-owed-me').textContent = `Мне должны: ${owedToMe.toLocaleString('de-DE')} €`;
  document.getElementById('stat-sub-owed-by').textContent = `Я должен: ${owedByMe.toLocaleString('de-DE')} €`;
  
  document.getElementById('stat-paid-month').textContent = `${paidThisMonth.toLocaleString('de-DE')} €`;
  document.getElementById('stat-active-count').textContent = activeCount;

  // Set month text in paid stat subtext
  const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  document.getElementById('stat-paid-subtext').textContent = `За ${monthNames[now.getMonth()]} ${now.getFullYear()} г.`;

  // Calculate Incomes this month
  let incomeThisMonth = 0;
  state.incomes.forEach((inc) => {
    if (inc.date && inc.date.startsWith(currentYearMonth)) {
      incomeThisMonth += Number(inc.amount) || 0;
    } else if (inc.frequency === 'monthly') {
      incomeThisMonth += Number(inc.amount) || 0;
    }
  });
  
  const incomeEl = document.getElementById('stat-income-month');
  if (incomeEl) {
    incomeEl.textContent = `${incomeThisMonth.toLocaleString('de-DE')} €`;
  }
  const incomeSubEl = document.getElementById('stat-income-subtext');
  if (incomeSubEl) {
    incomeSubEl.textContent = `Активных источников: ${state.incomes.length}`;
  }

  // 1. Calculate Remaining Balance after payments (Card 5)
  // Remaining = Income this month - Payments made this month
  const remainingVal = incomeThisMonth - paidThisMonth;
  const remainingEl = document.getElementById('stat-remaining-balance');
  if (remainingEl) {
    remainingEl.textContent = `${remainingVal >= 0 ? '+' : ''}${remainingVal.toLocaleString('de-DE')} €`;
    remainingEl.className = 'stat-value ' + (remainingVal >= 0 ? 'text-success' : 'text-danger');
  }

  // 2. Calculate Debt Payoff Progress (Card 6)
  // We only track progress on our own liabilities (my-debt + regular)
  let totalInitial = 0;
  let totalBalance = 0;
  state.records.forEach((rec) => {
    if (rec.type === 'my-debt' || rec.type === 'regular') {
      totalInitial += Number(rec.initialAmount) || 0;
      totalBalance += Number(rec.balance) || 0;
    }
  });

  const totalPaid = Math.max(0, totalInitial - totalBalance);
  const progressPercent = totalInitial > 0 ? (totalPaid / totalInitial) * 100 : 100;
  
  const progressEl = document.getElementById('stat-payback-progress');
  if (progressEl) {
    progressEl.textContent = `${Math.round(progressPercent)}%`;
    progressEl.className = 'stat-value ' + (progressPercent === 100 ? 'text-success' : progressPercent > 50 ? 'text-warning' : 'text-danger');
  }

  const progressSubEl = document.getElementById('stat-payback-subtext');
  if (progressSubEl) {
    progressSubEl.textContent = `Выплачено: ${totalPaid.toLocaleString('de-DE')} € из ${totalInitial.toLocaleString('de-DE')} €`;
  }
}

// --- DYNAMIC RENDERING ---

// Render table headers (static + dynamic custom columns)
function renderHeaders() {
  const tr = document.getElementById('table-headers');
  tr.innerHTML = '';

  // Standard Columns
  const baseHeaders = [
    { label: 'Название', key: 'name' },
    { label: 'Тип', key: 'type' },
    { label: 'Сумма', key: 'initialAmount' },
    { label: 'Остаток', key: 'balance' },
    { label: 'Статус', key: 'status' },
    { label: 'Взял', key: 'takenDate' },
    { label: 'Закрыл', key: 'closedDate' }
  ];

  baseHeaders.forEach(h => {
    tr.appendChild(buildSortHeaderCell('records', h.key, h.label));
  });

  // Custom Columns
  state.customColumns.forEach(col => {
    const th = buildSortHeaderCell('records', col.key, col.label, { customColumn: true });

    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = '&times;';
    deleteBtn.type = 'button';
    deleteBtn.style.position = 'absolute';
    deleteBtn.style.right = '0.6rem';
    deleteBtn.style.top = '50%';
    deleteBtn.style.transform = 'translateY(-50%)';
    deleteBtn.style.background = 'none';
    deleteBtn.style.border = 'none';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.style.fontSize = '1.2rem';
    deleteBtn.style.fontWeight = 'bold';
    deleteBtn.style.padding = '0';
    deleteBtn.style.lineHeight = '1';
    deleteBtn.title = `Удалить столбец "${col.label}"`;
    
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteCustomColumn(col.key, col.label);
    };

    th.appendChild(deleteBtn);
    tr.appendChild(th);
  });

  // Actions Column
  const thActions = document.createElement('th');
  thActions.textContent = 'Действия';
  thActions.style.width = '90px';
  thActions.style.textAlign = 'center';
  tr.appendChild(thActions);
}

function renderIncomesHeaders() {
  const tr = document.getElementById('incomes-table-headers');
  if (!tr) return;
  tr.innerHTML = '';

  const headers = [
    { label: 'Источник', key: 'name' },
    { label: 'Сумма', key: 'amount' },
    { label: 'Периодичность', key: 'frequency' },
    { label: 'Дата', key: 'date' }
  ];

  headers.forEach((header) => {
    tr.appendChild(buildSortHeaderCell('incomes', header.key, header.label));
  });

  const thActions = document.createElement('th');
  thActions.textContent = 'Действия';
  thActions.style.width = '70px';
  thActions.style.textAlign = 'center';
  tr.appendChild(thActions);
}

function renderGlobalHistoryHeaders() {
  const tr = document.getElementById('global-history-headers');
  if (!tr) return;
  tr.innerHTML = '';

  const headers = [
    { label: 'Дата', key: 'date' },
    { label: 'Описание', key: 'description' },
    { label: 'Категория', key: 'category' },
    { label: 'Сумма', key: 'amount' }
  ];

  headers.forEach((header) => {
    tr.appendChild(buildSortHeaderCell('history', header.key, header.label));
  });
}

function renderHistoryModalHeaders() {
  const tr = document.getElementById('history-table-headers');
  if (!tr) return;
  tr.innerHTML = '';

  const headers = [
    { label: 'Тип', key: 'type' },
    { label: 'Дата', key: 'date' },
    { label: 'Описание', key: 'description' },
    { label: 'Сумма', key: 'amount' },
    { label: 'Доказательство', key: 'proof' }
  ];

  headers.forEach((header) => {
    tr.appendChild(buildSortHeaderCell('history', header.key, header.label));
  });

  const thActions = document.createElement('th');
  thActions.textContent = 'Действия';
  thActions.style.width = '70px';
  thActions.style.textAlign = 'center';
  tr.appendChild(thActions);
}

// Render records list into table
function renderRecords() {
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  const records = sortRecords(state.records);

  if (records.length === 0) {
    const tr = document.createElement('tr');
    const colsCount = 8 + state.customColumns.length;
    tr.innerHTML = `<td colspan="${colsCount}" style="text-align: center; color: var(--text-secondary); padding: 2.5rem;">Нет активных или закрытых обязательств. Добавьте первую запись!</td>`;
    tbody.appendChild(tr);
    return;
  }

  records.forEach((rec) => {
    const tr = document.createElement('tr');

    // 1. Name
    const tdName = document.createElement('td');
    tdName.textContent = rec.name;
    tdName.style.fontWeight = '500';
    tr.appendChild(tdName);

    // 2. Type
    const tdType = document.createElement('td');
    tdType.textContent = getRecordTypeDisplayLabel(rec) || '—';
    tr.appendChild(tdType);

    // 3. Initial Sum
    const tdInitial = document.createElement('td');
    tdInitial.textContent = `${(Number(rec.initialAmount) || 0).toLocaleString('de-DE')} €`;
    tr.appendChild(tdInitial);

    // 4. Remaining Balance
    const tdBalance = document.createElement('td');
    tdBalance.textContent = `${(Number(rec.balance) || 0).toLocaleString('de-DE')} €`;
    tdBalance.style.fontWeight = '600';
    if (rec.status === 'Active') {
      tdBalance.classList.add(rec.type === 'debt-to-me' ? 'text-success' : 'text-danger');
    }
    tr.appendChild(tdBalance);

    // 5. Status
    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = rec.status === 'Active' 
      ? '<span class="badge badge-status-active">Активен</span>' 
      : '<span class="badge badge-status-closed">Закрыт</span>';
    tr.appendChild(tdStatus);

    // 6. Taken Date
    const tdTaken = document.createElement('td');
    if (rec.takenDate) {
      const dateParts = rec.takenDate.split('-');
      tdTaken.textContent = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : rec.takenDate;
    } else {
      tdTaken.textContent = '—';
      tdTaken.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdTaken);

    // 7. Closed Date
    const tdClosed = document.createElement('td');
    if (rec.closedDate) {
      const dateParts = rec.closedDate.split('-');
      tdClosed.textContent = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : rec.closedDate;
    } else {
      tdClosed.textContent = '—';
      tdClosed.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdClosed);

    // Custom Columns
    state.customColumns.forEach((col) => {
      const tdCustom = document.createElement('td');
      const val = rec[col.key];
      if (val === undefined || val === null || val === '') {
        tdCustom.textContent = '—';
        tdCustom.style.color = 'var(--text-muted)';
      } else {
        if (col.type === 'number') {
          tdCustom.textContent = Number(val).toLocaleString('ru-RU');
        } else if (col.type === 'date') {
          const dateParts = val.split('-');
          tdCustom.textContent = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : val;
        } else {
          tdCustom.textContent = val;
        }
      }
      tr.appendChild(tdCustom);
    });

    // 6. Actions Column
    const tdActions = document.createElement('td');
    tdActions.style.textAlign = 'center';
    
    // Deduct button (only enabled if Active)
    const deductDisabled = rec.status !== 'Active' ? 'disabled style="opacity: 0.3; cursor: not-allowed;"' : '';
    
    tdActions.innerHTML = `
      <div class="row-actions">
        <button class="btn-row-action" title="Списать / Внести платеж" aria-label="Списать / Внести платеж" onclick="openDeductModal('${rec.id}')" ${deductDisabled}>${icon('coin')}</button>
        <button class="btn-row-action" title="Редактировать" onclick="openEditRecordModal('${rec.id}')">
          ${icon('edit')}
        </button>
        <button class="btn-row-action delete" title="Удалить" onclick="deleteRecord('${rec.id}')">
          ${icon('trash')}
        </button>
      </div>
    `;
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

// Generate dynamic fields HTML inside Add/Edit modal based on settings
function renderDynamicFormFields(recordData = {}) {
  const container = document.getElementById('dynamic-fields-container');
  container.innerHTML = '';

  state.customColumns.forEach((col) => {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.setAttribute('for', `dynamic-${col.key}`);
    label.textContent = col.label;
    group.appendChild(label);

    let input;
    if (col.type === 'date') {
      input = document.createElement('input');
      input.type = 'date';
    } else if (col.type === 'number') {
      input = document.createElement('input');
      input.type = 'number';
      input.placeholder = '0';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Введите текст';
    }

    input.id = `dynamic-${col.key}`;
    input.className = 'input-control';
    input.dataset.key = col.key;
    input.value = recordData[col.key] || '';

    group.appendChild(input);
    container.appendChild(group);
  });
}

// --- OPERATIONS & ACTIONS ---

// Create Account or Log in
function setupUIEventListeners() {
  // 1. Firebase Config Setup Form
  document.getElementById('setup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const configStr = document.getElementById('config-json').value.trim();
    try {
      // Validate JSON
      const configObj = JSON.parse(configStr);
      if (!configObj.apiKey || !configObj.projectId) {
        throw new Error('Конфигурация должна содержать хотя бы apiKey и projectId.');
      }
      localStorage.setItem('firebase_config', JSON.stringify(configObj));
      alert('Конфигурация Firebase сохранена. Страница будет перезагружена.');
      window.location.reload();
    } catch (err) {
      alert('Ошибка разбора JSON: ' + err.message);
    }
  });

  // 2. Auth Toggle Link (Switch between Log in & Register)
  const authLink = document.getElementById('auth-toggle-link');
  authLink.addEventListener('click', (e) => {
    e.preventDefault();
    const isLogin = document.getElementById('auth-title').textContent === 'Вход в систему';
    if (isLogin) {
      document.getElementById('auth-title').textContent = 'Регистрация';
      document.getElementById('auth-subtitle').textContent = 'Создайте аккаунт для начала работы';
      document.getElementById('auth-submit-btn').textContent = 'Зарегистрироваться';
      document.getElementById('auth-toggle-text').textContent = 'Уже есть аккаунт?';
      authLink.textContent = 'Войти';
    } else {
      document.getElementById('auth-title').textContent = 'Вход в систему';
      document.getElementById('auth-subtitle').textContent = 'Введите ваши данные для доступа к реестру долгов';
      document.getElementById('auth-submit-btn').textContent = 'Войти';
      document.getElementById('auth-toggle-text').textContent = 'Еще нет аккаунта?';
      authLink.textContent = 'Зарегистрироваться';
    }
  });

  // 3. Auth Form Submit (Login / Register)
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const isLogin = document.getElementById('auth-title').textContent === 'Вход в систему';

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(state.auth, email, password);
      } else {
        await createUserWithEmailAndPassword(state.auth, email, password);
        alert('Регистрация прошла успешно!');
      }
    } catch (error) {
      console.error('Authentication error:', error);
      alert('Ошибка авторизации: ' + translateAuthError(error.code));
    }
  });

  // 4. Logout Button
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await signOut(state.auth);
    } catch (error) {
      console.error('Logout error:', error);
    }
  });

  // 5. Open Add Record Modal
  document.getElementById('btn-add-record').addEventListener('click', () => {
    document.getElementById('record-id').value = '';
    document.getElementById('record-modal-title').textContent = 'Добавить обязательство';
    document.getElementById('record-form').reset();
    document.getElementById('record-type').value = '';
    document.getElementById('record-category').value = 'my-debt';
    document.getElementById('record-taken-date').value = '';
    document.getElementById('record-closed-date').value = '';
    document.getElementById('balance-group').classList.remove('hidden');
    renderDynamicFormFields();
    window.openModal('record-modal');
  });

  // 6. Record Form Submit (Add / Edit)
  document.getElementById('record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentUser) return;

    const id = document.getElementById('record-id').value;
    const name = document.getElementById('record-name').value.trim();
    const typeLabel = document.getElementById('record-type').value.trim();
    const type = document.getElementById('record-category').value || 'my-debt';
    const initialAmount = Number(document.getElementById('record-initial').value);
    
    // Balance logic: on Add, if empty, set equal to initialAmount.
    let balanceVal = document.getElementById('record-balance').value;
    let balance = balanceVal === '' ? initialAmount : Number(balanceVal);

    // Read date fields
    const takenDate = document.getElementById('record-taken-date').value || "";
    const closedDate = document.getElementById('record-closed-date').value || "";

    // Prepare main payload
    const recordData = {
      name,
      type,
      typeLabel,
      initialAmount,
      balance,
      status: balance === 0 ? 'Closed' : 'Active',
      takenDate,
      closedDate: (balance === 0 && !closedDate) ? new Date().toISOString().split('T')[0] : closedDate,
      userId: state.currentUser.uid,
      updatedAt: new Date().toISOString()
    };

    // Grab dynamic custom fields
    const dynamicInputs = document.querySelectorAll('#dynamic-fields-container input');
    dynamicInputs.forEach((input) => {
      const key = input.dataset.key;
      let val = input.value;
      if (input.type === 'number' && val !== '') {
        val = Number(val);
      }
      recordData[key] = val;
    });

    try {
      if (id) {
        // Edit mode (do not force rewrite balance to initial unless changed by user)
        if (balanceVal === '') {
          delete recordData.balance; // retain existing balance if they didn't touch it
          delete recordData.status;
        }
        await updateDoc(doc(state.db, 'records', id), recordData);
      } else {
        // Add mode
        recordData.createdAt = new Date().toISOString();
        recordData.history = []; // Initialize empty payoff history
        await addDoc(collection(state.db, 'records'), recordData);
      }
      window.closeModal('record-modal');
    } catch (error) {
      console.error('Error saving record:', error);
      alert('Ошибка при сохранении: ' + error.message);
    }
  });

  // 7. Open Add Column Modal
  document.getElementById('btn-add-column').addEventListener('click', () => {
    document.getElementById('column-form').reset();
    window.openModal('column-modal');
  });

  // 8. Custom Column Form Submit
  document.getElementById('column-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentUser) return;

    const label = document.getElementById('column-label').value.trim();
    const type = document.getElementById('column-type').value;
    
    // Generate safe variable key for JS/Firestore field names
    const key = 'col_' + Date.now();

    const newCol = { key, label, type };
    const updatedCols = [...state.customColumns, newCol];

    try {
      await setDoc(doc(state.db, 'settings', state.currentUser.uid), {
        customColumns: updatedCols
      }, { merge: true });
      
      window.closeModal('column-modal');
    } catch (error) {
      console.error('Error adding column:', error);
      alert('Ошибка добавления столбца: ' + error.message);
    }
  });

  // 9. Deduct / Pay-down Form Submit
  document.getElementById('deduct-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentUser) return;

    const id = document.getElementById('deduct-record-id').value;
    const amount = Number(document.getElementById('deduct-amount').value);
    const date = document.getElementById('deduct-date').value;

    const record = state.records.find(r => r.id === id);
    if (!record) return;

    if (amount <= 0) {
      alert('Сумма платежа должна быть больше 0.');
      return;
    }

    if (amount > record.balance) {
      alert(`Сумма платежа не может превышать текущий остаток (${record.balance.toLocaleString('de-DE')} €).`);
      return;
    }

    const newBalance = record.balance - amount;
    const newStatus = newBalance === 0 ? 'Closed' : 'Active';
    
    const transaction = { amount, date };
    const updatedHistory = Array.isArray(record.history) ? [...record.history, transaction] : [transaction];

    try {
      const updateData = {
        balance: newBalance,
        status: newStatus,
        history: updatedHistory,
        updatedAt: new Date().toISOString()
      };
      if (newBalance === 0) {
        updateData.closedDate = date;
      }
      await updateDoc(doc(state.db, 'records', id), updateData);
      window.closeModal('deduct-modal');
    } catch (error) {
      console.error('Error recording payment:', error);
      alert('Ошибка записи списания: ' + error.message);
    }
  });

  // 10. Open Add Income Modal
  document.getElementById('btn-add-income').addEventListener('click', () => {
    document.getElementById('income-id').value = '';
    document.getElementById('income-modal-title').textContent = 'Добавить доход';
    document.getElementById('income-form').reset();
    document.getElementById('income-date').value = new Date().toISOString().split('T')[0];
    window.openModal('income-modal');
  });

  // 11. Income Form Submit (Add / Edit)
  document.getElementById('income-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentUser) return;

    const id = document.getElementById('income-id').value;
    const name = document.getElementById('income-name').value.trim();
    const amount = Number(document.getElementById('income-amount').value);
    const frequency = document.getElementById('income-frequency').value;
    const date = document.getElementById('income-date').value;

    const incomeData = {
      name,
      amount,
      frequency,
      date,
      userId: state.currentUser.uid,
      updatedAt: new Date().toISOString()
    };

    try {
      if (id) {
        // Edit mode
        await updateDoc(doc(state.db, 'incomes', id), incomeData);
      } else {
        // Add mode
        incomeData.createdAt = new Date().toISOString();
        await addDoc(collection(state.db, 'incomes'), incomeData);
      }
      window.closeModal('income-modal');
    } catch (error) {
      console.error('Error saving income:', error);
      alert('Ошибка при сохранении дохода: ' + error.message);
    }
  });
}

// Open modal to deduct from balance
window.openDeductModal = function(id) {
  const record = state.records.find(r => r.id === id);
  if (!record) return;

  document.getElementById('deduct-record-id').value = id;
  document.getElementById('deduct-current-balance').textContent = `${record.balance.toLocaleString('de-DE')} €`;
  
  const amountInput = document.getElementById('deduct-amount');
  amountInput.value = '';
  amountInput.max = record.balance;
  
  document.getElementById('deduct-date').value = new Date().toISOString().split('T')[0];

  // Render History list
  const historyList = document.getElementById('payment-history-list');
  historyList.innerHTML = '';

  if (!record.history || record.history.length === 0) {
    historyList.innerHTML = '<li class="payment-history-empty">История платежей пуста.</li>';
  } else {
    // Sort transactions date descending
    const sortedHistory = [...record.history].sort((a, b) => b.date.localeCompare(a.date));
    sortedHistory.forEach((tx) => {
      const li = document.createElement('li');
      li.className = 'payment-history-item';
      
      const dateParts = tx.date.split('-');
      const formattedDate = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : tx.date;
      
      li.innerHTML = `
        <span style="color: var(--text-secondary);">${formattedDate}</span>
        <span style="font-weight: 600; color: var(--success);">- ${tx.amount.toLocaleString('de-DE')} €</span>
      `;
      historyList.appendChild(li);
    });
  }

  window.openModal('deduct-modal');
};

// Open edit modal
window.openEditRecordModal = function(id) {
  const record = state.records.find(r => r.id === id);
  if (!record) return;

  document.getElementById('record-id').value = id;
  document.getElementById('record-modal-title').textContent = 'Редактировать обязательство';
  
  document.getElementById('record-name').value = record.name;
  document.getElementById('record-type').value = getRecordTypeDisplayLabel(record);
  document.getElementById('record-category').value = record.type || 'my-debt';
  document.getElementById('record-initial').value = record.initialAmount;
  
  // Show and populate balance
  document.getElementById('record-balance').value = record.balance;
  document.getElementById('balance-group').classList.remove('hidden');

  // Populate dates
  document.getElementById('record-taken-date').value = record.takenDate || '';
  document.getElementById('record-closed-date').value = record.closedDate || '';

  renderDynamicFormFields(record);
  window.openModal('record-modal');
};

// Delete record action
window.deleteRecord = async function(id) {
  if (confirm('Вы уверены, что хотите окончательно удалить эту запись?')) {
    try {
      await deleteDoc(doc(state.db, 'records', id));
    } catch (error) {
      console.error('Error deleting record:', error);
      alert('Ошибка при удалении: ' + error.message);
    }
  }
};

// Open proof upload modal
// Proof upload functionality removed per user request

window.addEventListener('load', () => {
  const incomeProofForm = document.getElementById('income-proof-form');
  if (!incomeProofForm) return;
  incomeProofForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    console.log('Submitting income proof for ID:', state.currentProofIncomeId);
    if (!state.currentProofIncomeId) {
      alert('Не выбран доход для загрузки доказательства.');
      return;
    }
    if (!state.currentUser) return;
    const file = document.getElementById('income-proof-file').files[0];
    if (!file) {
      alert('Пожалуйста, выберите файл доказательства.');
      return;
    }
    try {
      const fileRef = storageRef(state.storage,
        `income-proofs/${state.currentProofIncomeId}/${file.name}`);
      await uploadBytes(fileRef, file);
      const url = await getDownloadURL(fileRef);
      await updateDoc(doc(state.db, 'incomes', state.currentProofIncomeId), {
        proofUrl: url,
        updatedAt: new Date().toISOString()
      });
      window.closeModal('income-proof-modal');
      renderIncomes();
    } catch (error) {
      console.error('Error uploading income proof:', error);
      alert('Ошибка при загрузке доказательства: ' + error.message);
    }
  });
});

// Open proof upload modal for income
window.openIncomeProofModal = function(incomeId) {
  state.currentProofIncomeId = incomeId;
  console.log('Opened income proof modal for ID:', incomeId);
  const fileInput = document.getElementById('income-proof-file');
  if (fileInput) fileInput.value = '';
  window.openModal('income-proof-modal');
};



function renderHistoryModal() {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  renderHistoryModalHeaders();

  const allTransactions = sortTransactions(buildTransactions());
  const totalsDiv = document.getElementById('history-totals');
  if (totalsDiv) {
    const totalIncome = allTransactions.reduce((sum, tx) => tx.isPositive ? sum + Number(tx.amount || 0) : sum, 0);
    const totalExpense = allTransactions.reduce((sum, tx) => !tx.isPositive ? sum + Number(tx.amount || 0) : sum, 0);
    const net = totalIncome - totalExpense;
    totalsDiv.innerHTML = `
      <div style="margin-top:1rem; font-weight:600;">
        <span>Итого доход: +${totalIncome.toLocaleString('de-DE')} €</span> |
        <span>Итого расход: -${totalExpense.toLocaleString('de-DE')} €</span> |
        <span>Чистый результат: ${net >= 0 ? '+' : '-'}${Math.abs(net).toLocaleString('de-DE')} €</span>
      </div>`;
  }

  if (allTransactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-secondary);padding:2.5rem;">История транзакций пока пуста.</td></tr>`;
    return;
  }

  allTransactions.forEach((tx) => {
    const tr = document.createElement('tr');

    const tdType = document.createElement('td');
    tdType.innerHTML = `<span class="badge ${tx.isPositive ? 'badge-regular' : 'badge-my-debt'}">${tx.type}</span>`;
    tr.appendChild(tdType);

    const tdDate = document.createElement('td');
    const parts = tx.date.split('-');
    tdDate.textContent = parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : tx.date;
    tr.appendChild(tdDate);

    const tdDesc = document.createElement('td');
    tdDesc.textContent = tx.description;
    tdDesc.style.fontWeight = '500';
    tr.appendChild(tdDesc);

    const tdAmount = document.createElement('td');
    tdAmount.textContent = `${tx.isPositive ? '+' : '-'}${Number(tx.amount || 0).toLocaleString('de-DE')} €`;
    tdAmount.style.fontWeight = '600';
    tdAmount.classList.add(tx.isPositive ? 'text-success' : 'text-danger');
    tr.appendChild(tdAmount);

    const tdProof = document.createElement('td');
    if (tx.proofUrl) {
      const a = document.createElement('a');
      a.href = tx.proofUrl;
      a.target = '_blank';
      a.className = 'proof-link';
      a.title = 'Открыть доказательство';
      a.innerHTML = icon('paperclip');
      tdProof.appendChild(a);
    } else {
      tdProof.textContent = '—';
    }
    tr.appendChild(tdProof);

    const tdActions = document.createElement('td');
    tdActions.innerHTML = `<button class="btn-row-action delete" title="Удалить" aria-label="Удалить" onclick="deleteHistoryRow(this)">${icon('trash')}</button>`;
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

// Open unified history modal
window.openHistoryModal = function() {
  renderHistoryModal();
  window.openModal('history-modal');
};

// Add listener for history button
document.getElementById('btn-view-history').addEventListener('click', openHistoryModal);


// Translate Firebase Auth error codes to user-friendly Russian messages
function translateAuthError(code) {
  switch (code) {
    case 'auth/invalid-email':
      return 'Некорректный адрес электронной почты.';
    case 'auth/user-disabled':
      return 'Учетная запись отключена.';
    case 'auth/user-not-found':
      return 'Пользователь не найден.';
    case 'auth/wrong-password':
      return 'Неверный пароль.';
    case 'auth/email-already-in-use':
      return 'Этот адрес электронной почты уже используется другим пользователем.';
    case 'auth/weak-password':
      return 'Пароль должен состоять минимум из 6 символов.';
    case 'auth/invalid-credential':
      return 'Неверные учетные данные. Пожалуйста, проверьте email и пароль.';
    default:
      return 'Произошла непредвиденная ошибка. Код: ' + code;
  }
}

// Delete custom column action
window.deleteCustomColumn = async function(columnKey, columnLabel) {
  if (confirm(`Вы уверены, что хотите удалить столбец "${columnLabel}"? Данные этого столбца перестанут отображаться.`)) {
    if (!state.currentUser) return;

    if (state.sorting.records.key === columnKey) {
      state.sorting.records = { key: 'name', direction: 'asc' };
    }

    const updatedCols = state.customColumns.filter(col => col.key !== columnKey);

    try {
      await setDoc(doc(state.db, 'settings', state.currentUser.uid), {
        customColumns: updatedCols
      }, { merge: true });
    } catch (error) {
      console.error('Error deleting column:', error);
      alert('Ошибка при удалении столбца: ' + error.message);
    }
  }
};

function buildTransactions() {
  const allTransactions = [];

  state.records.forEach((rec) => {
    if (Array.isArray(rec.history)) {
      rec.history.forEach((tx) => {
        const isOutflow = rec.type === 'my-debt' || rec.type === 'regular';
        allTransactions.push({
          type: isOutflow ? 'Расход (Списание)' : 'Возврат долга',
          date: tx.date,
          description: isOutflow ? `Выплата по долгу: ${rec.name}` : `Получен платеж: ${rec.name}`,
          category: isOutflow ? 'Расход (Списание)' : 'Возврат долга',
          categoryClass: isOutflow ? 'badge-my-debt' : 'badge-debt-to-me',
          amount: tx.amount,
          isPositive: !isOutflow,
          proofUrl: rec.proofUrl || null
        });
      });
    }
  });

  state.incomes.forEach((inc) => {
    if (inc.date) {
      let freqLabel = 'Разовый доход';
      if (inc.frequency === 'monthly') freqLabel = 'Ежемесячный доход';
      else if (inc.frequency === 'weekly') freqLabel = 'Еженедельный доход';

      allTransactions.push({
        type: 'Доход',
        date: inc.date,
        description: `Доход: ${inc.name}`,
        category: freqLabel,
        categoryClass: 'badge-regular',
        amount: inc.amount,
        isPositive: true,
        proofUrl: null
      });
    }
  });

  return allTransactions;
}

// Render global payment and write-off history
function renderGlobalHistory() {
  const tbody = document.getElementById('global-history-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  renderGlobalHistoryHeaders();

  const allTransactions = sortTransactions(buildTransactions());

  if (allTransactions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 2.5rem;">История транзакций пока пуста.</td></tr>`;
    return;
  }

  allTransactions.forEach(tx => {
    const tr = document.createElement('tr');
    
    // 1. Date
    const tdDate = document.createElement('td');
    const dateParts = tx.date.split('-');
    tdDate.textContent = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : tx.date;
    tr.appendChild(tdDate);

    // 2. Description
    const tdDesc = document.createElement('td');
    tdDesc.textContent = tx.description;
    tdDesc.style.fontWeight = '500';
    tr.appendChild(tdDesc);

    // 3. Category Badge
    const tdCat = document.createElement('td');
    tdCat.innerHTML = `<span class="badge ${tx.categoryClass}">${tx.category}</span>`;
    tr.appendChild(tdCat);

    // 4. Amount (+/-)
    const tdAmount = document.createElement('td');
    tdAmount.textContent = `${tx.isPositive ? '+' : '-'}${tx.amount.toLocaleString('de-DE')} €`;
    tdAmount.style.fontWeight = '600';
    tdAmount.classList.add(tx.isPositive ? 'text-success' : 'text-danger');
    tr.appendChild(tdAmount);

    tbody.appendChild(tr);
  });
}

// Render incomes list into table
function renderIncomes() {
  const tbody = document.getElementById('incomes-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  const incomes = sortIncomes(state.incomes);

  renderIncomesHeaders();

  if (incomes.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 2.5rem;">Нет зарегистрированных источников дохода. Добавьте первый!</td>`;
    tbody.appendChild(tr);
    return;
  }

  incomes.forEach((inc) => {
    const tr = document.createElement('tr');

    // 1. Name
    const tdName = document.createElement('td');
    tdName.textContent = inc.name;
    tdName.style.fontWeight = '500';
    tr.appendChild(tdName);

    // 2. Amount
    const tdAmount = document.createElement('td');
    tdAmount.textContent = `${(Number(inc.amount) || 0).toLocaleString('de-DE')} €`;
    tdAmount.style.fontWeight = '600';
    tdAmount.classList.add('text-success');
    tr.appendChild(tdAmount);

    // 3. Frequency
    const tdFreq = document.createElement('td');
    let freqText = '';
    if (inc.frequency === 'monthly') {
      freqText = 'Ежемесячно';
    } else if (inc.frequency === 'weekly') {
      freqText = 'Еженедельно';
    } else {
      freqText = 'Разовый доход';
    }
    tdFreq.textContent = freqText;
    tr.appendChild(tdFreq);

    // 4. Date
    const tdDate = document.createElement('td');
    if (inc.date) {
      const dateParts = inc.date.split('-');
      tdDate.textContent = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : inc.date;
    } else {
      tdDate.textContent = '—';
    }
    tr.appendChild(tdDate);

    // 5. Actions
    const tdActions = document.createElement('td');
    tdActions.style.textAlign = 'center';
    tdActions.innerHTML = `
<div class="row-actions">
          <button class="btn-row-action" title="Добавить доказательство" aria-label="Добавить доказательство" onclick="openIncomeProofModal('${inc.id}')">${icon('paperclip')}</button>
          <button class="btn-row-action" title="Редактировать" onclick="openEditIncomeModal('${inc.id}')">
            ${icon('edit')}
          </button>
          <button class="btn-row-action delete" title="Удалить" onclick="deleteIncome('${inc.id}')">
            ${icon('trash')}
          </button>
        </div>
    `;
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

// Open modal to edit income
window.openEditIncomeModal = function(id) {
  const inc = state.incomes.find(i => i.id === id);
  if (!inc) return;

  document.getElementById('income-id').value = id;
  document.getElementById('income-modal-title').textContent = 'Редактировать доход';
  
  document.getElementById('income-name').value = inc.name;
  document.getElementById('income-amount').value = inc.amount;
  document.getElementById('income-frequency').value = inc.frequency;
  document.getElementById('income-date').value = inc.date || '';

  window.openModal('income-modal');
};

// Delete income action
window.deleteIncome = async function(id) {
  if (confirm('Вы уверены, что хотите удалить этот источник дохода?')) {
    try {
      await deleteDoc(doc(state.db, 'incomes', id));
    } catch (error) {
      console.error('Error deleting income:', error);
      alert('Ошибка при удалении дохода: ' + error.message);
    }
  }
};

// Delete a history row (income/expense) from the unified history modal
window.deleteHistoryRow = function(button) {
  if (!confirm('Вы уверены, что хотите удалить эту запись из истории?')) return;
  const tr = button.closest('tr');
  if (tr) tr.remove();

  // Recalculate totals after deletion
  const tbody = document.getElementById('history-table-body');
  const totalsDiv = document.getElementById('history-totals');
  if (!tbody || !totalsDiv) return;
  let totalIncome = 0;
  let totalExpense = 0;
  tbody.querySelectorAll('tr').forEach(row => {
    const amountCell = row.children[3]; // amount column
    if (!amountCell) return;
    const raw = amountCell.textContent.trim();
    // Extract numeric part, handle locale like '+1.234,56 €'
    const numStr = raw.replace(/[^\d\-,]/g, '').replace(/\./g, '').replace(',', '.');
    const amount = parseFloat(numStr);
    if (isNaN(amount)) return;
    if (raw.startsWith('+')) {
      totalIncome += amount;
    } else {
      totalExpense += amount;
    }
  });
  const net = totalIncome - totalExpense;
  totalsDiv.innerHTML = `
    <div style="margin-top:1rem; font-weight:600;">
      <span>Итого доход: +${totalIncome.toLocaleString('de-DE')} €</span> |
      <span>Итого расход: -${totalExpense.toLocaleString('de-DE')} €</span> |
      <span>Чистый результат: ${net >= 0 ? '+' : '-'}${Math.abs(net).toLocaleString('de-DE')} €</span>
    </div>`;
};
