const loginSection = document.getElementById('login-section');
const listSection = document.getElementById('list-section');
const secretInput = document.getElementById('secret-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const groupList = document.getElementById('group-list');
const emptyMsg = document.getElementById('empty-msg');

let secret = sessionStorage.getItem('ar_secret') || '';

if (secret) tryLoad();

loginBtn.addEventListener('click', () => {
    secret = secretInput.value.trim();
    if (!secret) return;
    tryLoad();
});

secretInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginBtn.click();
});

logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('ar_secret');
    secret = '';
    listSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
    secretInput.value = '';
});

async function tryLoad() {
    loginError.classList.add('hidden');
    const res = await fetch('/api/list', {
        headers: { 'X-Delete-Secret': secret }
    });
    if (res.status === 403) {
        sessionStorage.removeItem('ar_secret');
        loginError.classList.remove('hidden');
        return;
    }
    sessionStorage.setItem('ar_secret', secret);
    loginSection.classList.add('hidden');
    listSection.classList.remove('hidden');

    const data = await res.json();
    renderGroups(data.groups || []);
}

function renderGroups(groups) {
    groupList.innerHTML = '';
    if (groups.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');

    for (const g of groups) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = g.id;

        const date = g.createdAt ? new Date(g.createdAt).toLocaleString('ko-KR') : '날짜 없음';
        const title = g.title || '(제목 없음)';
        const arUrl = `${location.origin}/ar/${g.id}`;

        const fileItems = g.files.map(f => {
            const icon = f.type.startsWith('video/') ? '🎬' : '🖼️';
            const size = (f.size / 1024 / 1024).toFixed(1);
            return `<span class="file-tag">${icon} ${f.filename} (${size}MB)</span>`;
        }).join('');

        card.innerHTML = `
            <div class="card-top">
                <div class="card-info">
                    <div class="card-title">${escHtml(title)}</div>
                    <div class="card-date">${date}</div>
                    <div class="card-files">${fileItems}</div>
                </div>
                <button class="del-btn" data-id="${g.id}">삭제</button>
            </div>
            <div class="card-link">
                <input type="text" readonly value="${arUrl}">
                <button class="copy-btn">복사</button>
                <a href="${arUrl}" target="_blank" class="open-btn">열기</a>
            </div>
        `;

        card.querySelector('.del-btn').addEventListener('click', () => deleteGroup(g.id, card));
        card.querySelector('.copy-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(arUrl);
            card.querySelector('.copy-btn').textContent = '복사됨!';
            setTimeout(() => card.querySelector('.copy-btn').textContent = '복사', 1500);
        });

        groupList.appendChild(card);
    }
}

async function deleteGroup(id, card) {
    if (!confirm('이 항목을 삭제하시겠습니까?')) return;

    const btn = card.querySelector('.del-btn');
    btn.textContent = '삭제 중...';
    btn.disabled = true;

    const res = await fetch(`/api/delete/${id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Secret': secret }
    });

    if (res.ok) {
        card.classList.add('removing');
        setTimeout(() => card.remove(), 300);
        if (groupList.children.length === 0) emptyMsg.classList.remove('hidden');
    } else {
        btn.textContent = '삭제';
        btn.disabled = false;
        alert('삭제 실패');
    }
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
