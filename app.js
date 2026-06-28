/* =========================================================================
   نظام إدارة محل الخياطة - "الخيط الذهبي"
   ملف الجافاسكريبت الرئيسي (app.js)
   النسخة المرتبطة بـ Firebase: المصادقة عبر Firebase Authentication،
   والبيانات (العملاء، المقاسات، الطلبات) تُخزَّن وتُزامَن لحظيًا عبر Firestore.
   الكود منظم على شكل أقسام مرقّمة لتسهيل القراءة والتعديل.
   يتطلب وجود ملف firebase-config.js محمَّلاً قبل هذا الملف (يوفّر auth و db).
   ========================================================================= */

document.addEventListener("DOMContentLoaded", function () {
  "use strict";

  /* =========================================================================
     القسم 1: الحالة العامة (State) + أسماء مجموعات Firestore
     ========================================================================= */
  const COLLECTIONS = {
    customers: "customers",
    measurements: "measurements",
    orders: "orders",
  };

  // قوائم الحالة الرئيسية، تُحدَّث تلقائيًا عبر مستمعي Firestore (onSnapshot)
  let customers = [];
  let measurements = [];
  let orders = [];
  let currentUser = null; // مستخدم Firebase الحالي

  // مستمعو Firestore النشطون (لإلغاء الاشتراك عند تسجيل الخروج)
  let unsubscribers = [];

  // الحقول القياسية للمقاسات — تم تحديدها حسب طلب صاحب المحل: ٦ حقول فقط
  // "التركيز" مصطلح خاص بصاحب المحل ويُستخدم كما هو بدون تغيير
  const STANDARD_MEASURE_FIELDS = [
    { key: "shoulders", label: "الأكتاف" },
    { key: "focus", label: "التركيز" },
    { key: "chest", label: "الصدر" },
    { key: "sleeve", label: "الكم" },
    { key: "waistBelt", label: "الحزام" },
    { key: "length", label: "الطول" },
  ];

  const ORDER_STATUSES = ["جديد", "قيد التنفيذ", "جاهز", "تم التسليم", "ملغي"];
  const STATUS_BADGE_CLASS = {
    "جديد": "badge-new",
    "قيد التنفيذ": "badge-progress",
    "جاهز": "badge-ready",
    "تم التسليم": "badge-delivered",
    "ملغي": "badge-cancelled",
  };

  /* =========================================================================
     القسم 2: دوال مساعدة عامة (تنسيق، تنبيهات، أدوات)
     ========================================================================= */
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function formatDateArabic(isoDate) {
    if (!isoDate) return "—";
    const d = new Date(isoDate);
    if (isNaN(d)) return isoDate;
    return d.toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function initials(name) {
    if (!name) return "؟";
    const parts = name.trim().split(/\s+/);
    return (parts[0] ? parts[0][0] : "") + (parts[1] ? parts[1][0] : "");
  }

  function showToast(message, type) {
    type = type || "success";
    const container = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast " + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-16px)";
      toast.style.transition = "opacity .25s, transform .25s";
      setTimeout(function () { toast.remove(); }, 250);
    }, 2600);
  }

  function findCustomer(id) {
    return customers.find(function (c) { return c.id === id; });
  }

  // ترجمة رسائل أخطاء Firebase الشائعة إلى رسائل عربية مفهومة
  function translateFirebaseError(err) {
    const code = err && err.code ? err.code : "";
    const map = {
      "auth/invalid-email": "صيغة البريد الإلكتروني غير صحيحة",
      "auth/user-not-found": "لا يوجد حساب بهذا البريد الإلكتروني",
      "auth/wrong-password": "كلمة المرور غير صحيحة",
      "auth/invalid-credential": "البريد الإلكتروني أو كلمة المرور غير صحيحة",
      "auth/invalid-login-credentials": "البريد الإلكتروني أو كلمة المرور غير صحيحة",
      "auth/too-many-requests": "تم تجاوز عدد المحاولات المسموح، يرجى المحاولة بعد قليل",
      "auth/network-request-failed": "تعذر الاتصال بالخادم، تحقق من اتصال الإنترنت",
      "auth/user-disabled": "تم تعطيل هذا الحساب",
      "auth/missing-email": "يرجى إدخال البريد الإلكتروني",
      "permission-denied": "لا تملك صلاحية الوصول إلى هذه البيانات",
      "unavailable": "تعذر الوصول إلى الخادم حاليًا، تحقق من اتصال الإنترنت",
    };
    return map[code] || ("حدث خطأ: " + (err && err.message ? err.message : "غير معروف"));
  }

  /* =========================================================================
     القسم 3: شارة حالة الاتصال/المزامنة (Sync Status)
     ========================================================================= */
  function setSyncStatus(status) {
    // status: "synced" | "saving" | "offline"
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.classList.remove("synced", "saving", "offline");
    el.classList.add(status);
    const labels = { synced: "متصل", saving: "جاري الحفظ...", offline: "غير متصل" };
    el.innerHTML = '<span class="sync-dot"></span><span>' + labels[status] + "</span>";
  }

  window.addEventListener("online", function () { setSyncStatus("synced"); });
  window.addEventListener("offline", function () { setSyncStatus("offline"); });

  /* =========================================================================
     القسم 4: المصادقة عبر Firebase Authentication
     ========================================================================= */
  function setLoginLoading(isLoading) {
    const btn = document.getElementById("loginSubmitBtn");
    const label = document.getElementById("loginSubmitLabel");
    btn.disabled = isLoading;
    label.innerHTML = isLoading ? '<span class="btn-spinner"></span> جاري تسجيل الدخول...' : "تسجيل الدخول";
  }

  function initAuth() {
    const loginForm = document.getElementById("loginForm");
    const loginError = document.getElementById("loginError");

    // مستمع حالة المصادقة: يتولى تلقائيًا تحديد الشاشة المعروضة
    // (يعمل عند فتح الصفحة لأول مرة وعند أي تغيير في حالة الدخول)
    auth.onAuthStateChanged(function (user) {
      document.getElementById("bootScreen").hidden = true;
      if (user) {
        currentUser = user;
        enterApp();
      } else {
        currentUser = null;
        teardownListeners();
        document.getElementById("appShell").hidden = true;
        document.getElementById("loginScreen").hidden = false;
      }
    });

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      const email = document.getElementById("loginUser").value.trim();
      const pass = document.getElementById("loginPass").value;
      loginError.hidden = true;
      setLoginLoading(true);

      auth.signInWithEmailAndPassword(email, pass)
        .catch(function (err) {
          loginError.textContent = translateFirebaseError(err);
          loginError.hidden = false;
        })
        .finally(function () { setLoginLoading(false); });
    });

    document.getElementById("forgotPasswordBtn").addEventListener("click", function () {
      const email = document.getElementById("loginUser").value.trim();
      if (!email) {
        loginError.textContent = "يرجى إدخال البريد الإلكتروني أولاً لإرسال رابط إعادة التعيين";
        loginError.hidden = false;
        return;
      }
      auth.sendPasswordResetEmail(email)
        .then(function () { showToast("تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني"); })
        .catch(function (err) {
          loginError.textContent = translateFirebaseError(err);
          loginError.hidden = false;
        });
    });

    document.getElementById("logoutBtn").addEventListener("click", function () {
      auth.signOut().then(function () {
        loginForm.reset();
        showToast("تم تسجيل الخروج بنجاح", "info");
      });
    });
  }

  function enterApp() {
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("appShell").hidden = false;
    document.getElementById("currentUserLabel").textContent = "مرحبًا، " + currentUser.email;
    document.getElementById("settingsUserEmail").textContent = currentUser.email;
    setSyncStatus(navigator.onLine ? "synced" : "offline");
    attachFirestoreListeners();
  }

  /* =========================================================================
     القسم 5: مستمعو Firestore اللحظية (Real-time Listeners)
     يتم استدعاؤها عند تسجيل الدخول، وإلغاؤها عند تسجيل الخروج
     ========================================================================= */
  function attachFirestoreListeners() {
    teardownListeners(); // أمان: تجنّب الاشتراك المزدوج

    const custUnsub = db.collection(COLLECTIONS.customers).orderBy("seq", "asc")
      .onSnapshot(function (snap) {
        customers = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
        renderDashboard();
        renderCustomers();
        renderMeasurements(); // أسماء العملاء قد تظهر في جدول المقاسات
        renderOrders();
        setSyncStatus("synced");
      }, handleFirestoreError);

    const measUnsub = db.collection(COLLECTIONS.measurements).orderBy("seq", "asc")
      .onSnapshot(function (snap) {
        measurements = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
        renderMeasurements();
        setSyncStatus("synced");
      }, handleFirestoreError);

    const ordUnsub = db.collection(COLLECTIONS.orders).orderBy("seq", "asc")
      .onSnapshot(function (snap) {
        orders = snap.docs.map(function (doc) { return Object.assign({ id: doc.id }, doc.data()); });
        renderDashboard();
        renderOrders();
        setSyncStatus("synced");
      }, handleFirestoreError);

    unsubscribers = [custUnsub, measUnsub, ordUnsub];
  }

  function teardownListeners() {
    unsubscribers.forEach(function (unsub) { if (typeof unsub === "function") unsub(); });
    unsubscribers = [];
    customers = []; measurements = []; orders = [];
  }

  function handleFirestoreError(err) {
    console.error("خطأ في الاتصال بـ Firestore:", err);
    setSyncStatus("offline");
    showToast(translateFirebaseError(err), "error");
  }

  // يحسب رقمًا تسلسليًا تاليًا بسيطًا (للعرض كـ #1, #2...) بالاعتماد على القائمة الحالية المحمّلة محليًا
  function nextSeq(list) {
    if (!list.length) return 1;
    return Math.max.apply(null, list.map(function (x) { return x.seq || 0; })) + 1;
  }

  /* =========================================================================
     القسم 6: التنقل بين الصفحات + قائمة الجوال
     ========================================================================= */
  const PAGE_TITLES = {
    dashboard: "لوحة التحكم",
    customers: "العملاء",
    measurements: "المقاسات",
    orders: "الطلبات",
    reports: "التقارير",
    settings: "الإعدادات",
  };

  function initNavigation() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(function (item) {
      item.addEventListener("click", function () {
        const page = this.dataset.page;
        navItems.forEach(function (n) { n.classList.remove("active"); });
        this.classList.add("active");

        document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
        document.getElementById("page-" + page).classList.add("active");
        document.getElementById("pageTitle").textContent = PAGE_TITLES[page];

        closeSidebarMobile();
      });
    });

    document.getElementById("sidebarOpenBtn").addEventListener("click", openSidebarMobile);
    document.getElementById("sidebarCloseBtn").addEventListener("click", closeSidebarMobile);
    document.getElementById("sidebarOverlay").addEventListener("click", closeSidebarMobile);
  }
  function openSidebarMobile() {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("sidebarOverlay").classList.add("show");
  }
  function closeSidebarMobile() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarOverlay").classList.remove("show");
  }

  /* =========================================================================
     القسم 7: الوضع الداكن / الفاتح
     ========================================================================= */
  function initTheme() {
    const saved = localStorage.getItem("tailor_theme") || "light";
    applyTheme(saved);
    document.getElementById("themeToggleBtn").addEventListener("click", function () {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "light" ? "dark" : "light";
      applyTheme(next);
      localStorage.setItem("tailor_theme", next);
    });
  }
  function applyTheme(theme) {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      document.getElementById("themeToggleLabel").textContent = "الوضع النهاري";
    } else {
      document.documentElement.removeAttribute("data-theme");
      document.getElementById("themeToggleLabel").textContent = "الوضع الليلي";
    }
  }

  /* =========================================================================
     القسم 8: النوافذ المنبثقة (Modal) - أدوات عامة
     ========================================================================= */
  function openModal(title, bodyHtml, onMount) {
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalBody").innerHTML = bodyHtml;
    document.getElementById("modalOverlay").hidden = false;
    document.body.style.overflow = "hidden";
    if (typeof onMount === "function") onMount();
  }
  function closeModal() {
    document.getElementById("modalOverlay").hidden = true;
    document.body.style.overflow = "";
    document.getElementById("modalBody").innerHTML = "";
  }
  function initModalShell() {
    document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
    document.getElementById("modalOverlay").addEventListener("click", function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !document.getElementById("modalOverlay").hidden) closeModal();
    });
  }

  function confirmAction(message, onConfirm) {
    openModal("تأكيد الإجراء", "" +
      '<p style="margin-bottom:18px;color:var(--text-soft);line-height:1.7">' + escapeHtml(message) + "</p>" +
      '<div class="modal-footer-actions">' +
      '<button class="btn btn-ghost" id="confirmCancelBtn">إلغاء</button>' +
      '<button class="btn btn-danger" id="confirmOkBtn">تأكيد</button>' +
      "</div>"
    );
    document.getElementById("confirmCancelBtn").addEventListener("click", closeModal);
    document.getElementById("confirmOkBtn").addEventListener("click", function () {
      closeModal();
      onConfirm();
    });
  }

  /* =========================================================================
     القسم 9: لوحة التحكم (Dashboard)
     ========================================================================= */
  function renderDashboard() {
    document.getElementById("statCustomers").textContent = customers.length;
    document.getElementById("statOrders").textContent = orders.length;
    document.getElementById("statReady").textContent = orders.filter(function (o) { return o.status === "جاهز"; }).length;
    document.getElementById("statInProgress").textContent = orders.filter(function (o) { return o.status === "قيد التنفيذ"; }).length;

    // أحدث العملاء (آخر 5 حسب تاريخ التسجيل)
    const latest = customers.slice().sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); }).slice(0, 5);
    const tbody = document.querySelector("#latestCustomersTable tbody");
    tbody.innerHTML = "";
    document.getElementById("latestCustomersEmpty").hidden = latest.length > 0;
    latest.forEach(function (c) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(c.name) + "</td>" +
        "<td>" + escapeHtml(c.phone) + "</td>" +
        "<td>" + formatDateArabic(c.createdAt) + "</td>";
      tbody.appendChild(tr);
    });

    // توزيع حالات الطلبات (أعمدة نسبية)
    const statusColors = {
      "جديد": "var(--info)", "قيد التنفيذ": "var(--warning)", "جاهز": "var(--success)",
      "تم التسليم": "var(--text-faint)", "ملغي": "var(--danger)",
    };
    const wrap = document.getElementById("statusBars");
    wrap.innerHTML = "";
    const total = orders.length || 1;
    ORDER_STATUSES.forEach(function (st) {
      const count = orders.filter(function (o) { return o.status === st; }).length;
      const pct = Math.round((count / total) * 100);
      const row = document.createElement("div");
      row.className = "status-bar-row";
      row.innerHTML =
        '<div class="status-bar-top"><span>' + st + '</span><span>' + count + '</span></div>' +
        '<div class="status-bar-track"><div class="status-bar-fill" style="width:' + pct + '%;background:' + statusColors[st] + '"></div></div>';
      wrap.appendChild(row);
    });
  }

  /* =========================================================================
     القسم 10: صفحة العملاء (Customers) — إضافة / تعديل / حذف / بحث / عرض
     ========================================================================= */
  function customerFormHtml(customer) {
    customer = customer || {};
    return '' +
      '<div class="photo-upload-row">' +
        '<div class="photo-preview" id="photoPreview">' +
          (customer.photo
            ? '<img src="' + customer.photo + '" alt="صورة العميل">'
            : '<svg style="width:28px;height:28px"><use href="#icon-camera"></use></svg>') +
        '</div>' +
        '<div>' +
          '<button type="button" class="btn btn-outline btn-sm" id="choosePhotoBtn">اختيار صورة</button>' +
          '<input type="file" id="customerPhotoInput" accept="image/*" hidden>' +
          '<p style="font-size:.76rem;color:var(--text-faint);margin-top:6px">صورة اختيارية للعميل (JPG أو PNG، يُفضَّل أصغر من 500 كيلوبايت)</p>' +
        '</div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="field"><label>الاسم الكامل *</label><input type="text" id="custName" value="' + escapeHtml(customer.name || "") + '" placeholder="مثال: محمد أحمد العلي" required></div>' +
        '<div class="field"><label>رقم الهاتف *</label><input type="tel" id="custPhone" value="' + escapeHtml(customer.phone || "") + '" placeholder="05xxxxxxxx" required></div>' +
      '</div>' +
      '<div class="field"><label>العنوان</label><input type="text" id="custAddress" value="' + escapeHtml(customer.address || "") + '" placeholder="الحي / المدينة"></div>' +
      '<div class="field"><label>ملاحظات</label><textarea id="custNotes" placeholder="أي ملاحظات إضافية عن العميل...">' + escapeHtml(customer.notes || "") + '</textarea></div>' +
      '<div class="modal-footer-actions">' +
        '<button type="button" class="btn btn-ghost" id="custCancelBtn">إلغاء</button>' +
        '<button type="submit" class="btn btn-primary" id="custSaveBtn"><svg class="btn-icon"><use href="#icon-check"></use></svg> حفظ</button>' +
      '</div>';
  }

  // يضغط الصورة ويصغّرها قبل تحويلها إلى base64 لتقليل حجمها (حد Firestore لكل وثيقة هو 1 ميغابايت)
  function readAndResizeImage(file, maxDim, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * (maxDim / w)); w = maxDim; }
          else { w = Math.round(w * (maxDim / h)); h = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function openCustomerForm(existingId) {
    const customer = existingId ? findCustomer(existingId) : null;
    const title = customer ? "تعديل بيانات العميل" : "إضافة عميل جديد";
    let photoData = customer ? customer.photo : null;

    openModal(title, '<form id="customerForm">' + customerFormHtml(customer) + '</form>', function () {
      const choosePhotoBtn = document.getElementById("choosePhotoBtn");
      const photoInput = document.getElementById("customerPhotoInput");
      const preview = document.getElementById("photoPreview");

      choosePhotoBtn.addEventListener("click", function () { photoInput.click(); });
      photoInput.addEventListener("change", function () {
        const file = this.files[0];
        if (!file) return;
        readAndResizeImage(file, 400, function (dataUrl) {
          photoData = dataUrl;
          preview.innerHTML = '<img src="' + photoData + '" alt="صورة العميل">';
        });
      });

      document.getElementById("custCancelBtn").addEventListener("click", closeModal);
      document.getElementById("customerForm").addEventListener("submit", function (e) {
        e.preventDefault();
        const name = document.getElementById("custName").value.trim();
        const phone = document.getElementById("custPhone").value.trim();
        const address = document.getElementById("custAddress").value.trim();
        const notes = document.getElementById("custNotes").value.trim();
        if (!name || !phone) { showToast("الاسم ورقم الهاتف مطلوبان", "error"); return; }

        const saveBtn = document.getElementById("custSaveBtn");
        saveBtn.disabled = true;
        setSyncStatus("saving");

        if (customer) {
          db.collection(COLLECTIONS.customers).doc(customer.id).update({
            name: name, phone: phone, address: address, notes: notes, photo: photoData,
          }).then(function () {
            showToast("تم تحديث بيانات العميل بنجاح");
            closeModal();
          }).catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        } else {
          db.collection(COLLECTIONS.customers).add({
            seq: nextSeq(customers), name: name, phone: phone, address: address,
            notes: notes, photo: photoData, createdAt: todayISO(),
          }).then(function () {
            showToast("تمت إضافة العميل بنجاح");
            closeModal();
          }).catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        }
      });
    });
  }

  function deleteCustomer(id) {
    confirmAction("سيتم حذف هذا العميل بشكل نهائي. هل تريد الاستمرار؟", function () {
      setSyncStatus("saving");
      db.collection(COLLECTIONS.customers).doc(id).delete()
        .then(function () { showToast("تم حذف العميل", "info"); })
        .catch(function (err) { showToast(translateFirebaseError(err), "error"); });
    });
  }

  function viewCustomerProfile(id) {
    const c = findCustomer(id);
    if (!c) return;
    const photoHtml = c.photo
      ? '<img src="' + c.photo + '" class="profile-photo" alt="">'
      : '<div class="profile-photo-placeholder">' + initials(c.name) + '</div>';

    const qrPayload = JSON.stringify({ id: c.id, name: c.name, phone: c.phone });

    openModal("ملف العميل", '' +
      '<div class="profile-view">' +
        '<div class="profile-head">' + photoHtml +
          '<div class="profile-info"><h4>' + escapeHtml(c.name) + '</h4><p>عميل رقم #' + c.seq + '</p></div>' +
        '</div>' +
        '<div class="profile-details">' +
          '<div class="detail-item"><span>رقم الهاتف</span><strong>' + escapeHtml(c.phone) + '</strong></div>' +
          '<div class="detail-item"><span>تاريخ التسجيل</span><strong>' + formatDateArabic(c.createdAt) + '</strong></div>' +
          '<div class="detail-item"><span>العنوان</span><strong>' + (escapeHtml(c.address) || "—") + '</strong></div>' +
          '<div class="detail-item"><span>ملاحظات</span><strong>' + (escapeHtml(c.notes) || "—") + '</strong></div>' +
        '</div>' +
        '<div class="qr-box" id="qrBoxTarget">' +
          '<small>رمز تعريفي بصري لملف العميل (للمسح السريع)</small>' +
        '</div>' +
        '<div class="modal-footer-actions">' +
          '<button type="button" class="btn btn-ghost" id="closeProfileBtn">إغلاق</button>' +
          '<button type="button" class="btn btn-outline" id="printProfileBtn"><svg class="btn-icon"><use href="#icon-print"></use></svg> طباعة بيانات العميل</button>' +
        '</div>' +
      '</div>'
    , function () {
      drawQrCode(document.getElementById("qrBoxTarget"), qrPayload);
      document.getElementById("closeProfileBtn").addEventListener("click", closeModal);
      document.getElementById("printProfileBtn").addEventListener("click", function () { printCustomer(c.id); });
    });
  }

  function renderCustomers(filterText) {
    const searchInput = document.getElementById("customerSearch");
    filterText = (filterText !== undefined ? filterText : searchInput.value).trim().toLowerCase();
    const tbody = document.querySelector("#customersTable tbody");
    tbody.innerHTML = "";

    const filtered = customers.filter(function (c) {
      if (!filterText) return true;
      return c.name.toLowerCase().includes(filterText) ||
        c.phone.toLowerCase().includes(filterText) ||
        String(c.seq).includes(filterText);
    }).sort(function (a, b) { return b.seq - a.seq; });

    document.getElementById("customersEmpty").hidden = filtered.length > 0;

    filtered.forEach(function (c) {
      const tr = document.createElement("tr");
      const photoCell = c.photo
        ? '<img src="' + c.photo + '" class="table-avatar" alt="">'
        : '<div class="table-avatar-placeholder">' + initials(c.name) + '</div>';
      tr.innerHTML =
        "<td>#" + c.seq + "</td>" +
        "<td>" + photoCell + "</td>" +
        "<td>" + escapeHtml(c.name) + "</td>" +
        "<td>" + escapeHtml(c.phone) + "</td>" +
        "<td>" + (escapeHtml(c.address) || "—") + "</td>" +
        "<td>" + formatDateArabic(c.createdAt) + "</td>" +
        '<td><div class="row-actions">' +
          '<button class="icon-btn view" title="عرض الملف" data-action="view" data-id="' + c.id + '"><svg><use href="#icon-eye"></use></svg></button>' +
          '<button class="icon-btn edit" title="تعديل" data-action="edit" data-id="' + c.id + '"><svg><use href="#icon-edit"></use></svg></button>' +
          '<button class="icon-btn danger" title="حذف" data-action="delete" data-id="' + c.id + '"><svg><use href="#icon-trash"></use></svg></button>' +
        '</div></td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-action]").forEach(function (btn) {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      btn.addEventListener("click", function () {
        if (action === "view") viewCustomerProfile(id);
        if (action === "edit") openCustomerForm(id);
        if (action === "delete") deleteCustomer(id);
      });
    });
  }

  function initCustomersPage() {
    document.getElementById("addCustomerBtn").addEventListener("click", function () { openCustomerForm(null); });
    document.getElementById("customerSearch").addEventListener("input", function () { renderCustomers(this.value); });
  }

  /* =========================================================================
     القسم 11: رمز تعريفي بصري (يُرسم بـ SVG بدون مكتبات خارجية)
     ملاحظة: نمط شبكي بصري فريد لكل عميل وليس رمز QR حقيقي قابل للقراءة
     بقارئ خارجي، نظرًا لعدم استخدام مكتبات خارجية.
     ========================================================================= */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  function drawQrCode(container, payload) {
    const size = 9; // شبكة 9x9
    const cell = 18;
    let seed = Math.abs(simpleHash(payload));
    function rand() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    let rects = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const isCorner = (x < 2 && y < 2) || (x >= size - 2 && y < 2) || (x < 2 && y >= size - 2);
        const filled = isCorner ? true : rand() > 0.52;
        if (filled) {
          rects += '<rect x="' + (x * cell) + '" y="' + (y * cell) + '" width="' + cell + '" height="' + cell + '" fill="#2B2622"/>';
        }
      }
    }
    const svgSize = size * cell;
    container.innerHTML =
      '<svg class="qr-svg" width="' + svgSize + '" height="' + svgSize + '" viewBox="0 0 ' + svgSize + ' ' + svgSize + '">' + rects + '</svg>' +
      '<small>رمز تعريفي بصري لملف العميل</small>';
  }

  /* =========================================================================
     القسم 12: صفحة المقاسات (Measurements)
     الحقول: الأكتاف، التركيز، الصدر، الكم، الحزام، الطول (٦ حقول فقط)
     ========================================================================= */
  let tempCustomFields = []; // الحقول المخصصة المؤقتة أثناء فتح نموذج المقاس

  function measurementFormHtml(measurement) {
    measurement = measurement || {};
    const custom = measurement.customFields || [];
    tempCustomFields = custom.map(function (f) { return { label: f.label, value: f.value }; });

    const customerOptions = customers.map(function (c) {
      const selected = measurement.customerId === c.id ? "selected" : "";
      return '<option value="' + c.id + '" ' + selected + '>' + escapeHtml(c.name) + ' (#' + c.seq + ')</option>';
    }).join("");

    const standardInputs = STANDARD_MEASURE_FIELDS.map(function (f) {
      const val = measurement[f.key] !== undefined && measurement[f.key] !== null ? measurement[f.key] : "";
      return '<div class="field"><label>' + f.label + ' (سم)</label><input type="number" step="0.1" min="0" id="m_' + f.key + '" value="' + val + '" placeholder="0"></div>';
    }).join("");

    return '' +
      '<div class="field"><label>العميل *</label><select id="measureCustomer" required>' +
        '<option value="">— اختر العميل —</option>' + customerOptions +
      '</select></div>' +
      '<div class="section-divider">معلومات المقاسات</div>' +
      '<div class="measure-grid">' + standardInputs + '</div>' +
      '<div class="section-divider">حقول مخصصة إضافية</div>' +
      '<div class="custom-fields-list" id="customFieldsList"></div>' +
      '<button type="button" class="add-field-btn" id="addCustomFieldBtn"><svg class="btn-icon"><use href="#icon-plus"></use></svg> إضافة حقل مقاس مخصص</button>' +
      '<div class="field" style="margin-top:14px"><label>ملاحظات إضافية</label><textarea id="measureNotes" placeholder="ملاحظات حول القياس...">' + escapeHtml(measurement.notes || "") + '</textarea></div>' +
      '<div class="modal-footer-actions">' +
        '<button type="button" class="btn btn-ghost" id="measureCancelBtn">إلغاء</button>' +
        '<button type="submit" class="btn btn-primary" id="measureSaveBtn"><svg class="btn-icon"><use href="#icon-check"></use></svg> حفظ المقاس</button>' +
      '</div>';
  }

  function renderCustomFieldsList() {
    const wrap = document.getElementById("customFieldsList");
    if (!wrap) return;
    wrap.innerHTML = "";
    tempCustomFields.forEach(function (field, idx) {
      const row = document.createElement("div");
      row.className = "custom-field-row";
      row.innerHTML =
        '<input type="text" placeholder="اسم الحقل (مثال: عرض الصدر الخلفي)" value="' + escapeHtml(field.label) + '" data-cf-label="' + idx + '">' +
        '<input type="text" placeholder="القيمة" value="' + escapeHtml(field.value) + '" data-cf-value="' + idx + '" style="max-width:120px">' +
        '<button type="button" class="icon-btn danger" data-cf-remove="' + idx + '"><svg><use href="#icon-trash"></use></svg></button>';
      wrap.appendChild(row);
    });
    wrap.querySelectorAll("[data-cf-label]").forEach(function (input) {
      input.addEventListener("input", function () { tempCustomFields[this.dataset.cfLabel].label = this.value; });
    });
    wrap.querySelectorAll("[data-cf-value]").forEach(function (input) {
      input.addEventListener("input", function () { tempCustomFields[this.dataset.cfValue].value = this.value; });
    });
    wrap.querySelectorAll("[data-cf-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        tempCustomFields.splice(parseInt(this.dataset.cfRemove, 10), 1);
        renderCustomFieldsList();
      });
    });
  }

  function openMeasurementForm(existingId) {
    const measurement = existingId ? measurements.find(function (m) { return m.id === existingId; }) : null;
    const title = measurement ? "تعديل المقاسات" : "إضافة مقاس جديد";

    if (!customers.length) {
      showToast("يجب إضافة عميل أولاً قبل تسجيل المقاسات", "error");
      return;
    }

    openModal(title, '<form id="measurementForm">' + measurementFormHtml(measurement) + '</form>', function () {
      renderCustomFieldsList();
      document.getElementById("addCustomFieldBtn").addEventListener("click", function () {
        tempCustomFields.push({ label: "", value: "" });
        renderCustomFieldsList();
      });
      document.getElementById("measureCancelBtn").addEventListener("click", closeModal);

      document.getElementById("measurementForm").addEventListener("submit", function (e) {
        e.preventDefault();
        const customerId = document.getElementById("measureCustomer").value;
        if (!customerId) { showToast("يجب اختيار العميل", "error"); return; }

        const data = { customerId: customerId };
        STANDARD_MEASURE_FIELDS.forEach(function (f) {
          const v = document.getElementById("m_" + f.key).value;
          data[f.key] = v === "" ? null : parseFloat(v);
        });
        data.notes = document.getElementById("measureNotes").value.trim();
        data.customFields = tempCustomFields.filter(function (f) { return f.label.trim() !== ""; });

        const saveBtn = document.getElementById("measureSaveBtn");
        saveBtn.disabled = true;
        setSyncStatus("saving");

        if (measurement) {
          db.collection(COLLECTIONS.measurements).doc(measurement.id).update(data)
            .then(function () { showToast("تم تحديث المقاسات بنجاح"); closeModal(); })
            .catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        } else {
          data.seq = nextSeq(measurements);
          data.createdAt = todayISO();
          db.collection(COLLECTIONS.measurements).add(data)
            .then(function () { showToast("تمت إضافة المقاس بنجاح"); closeModal(); })
            .catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        }
      });
    });
  }

  function deleteMeasurement(id) {
    confirmAction("سيتم حذف سجل المقاس هذا نهائيًا. هل تريد الاستمرار؟", function () {
      setSyncStatus("saving");
      db.collection(COLLECTIONS.measurements).doc(id).delete()
        .then(function () { showToast("تم حذف سجل المقاس", "info"); })
        .catch(function (err) { showToast(translateFirebaseError(err), "error"); });
    });
  }

  function viewMeasurement(id) {
    const m = measurements.find(function (x) { return x.id === id; });
    if (!m) return;
    const c = findCustomer(m.customerId);
    const rows = STANDARD_MEASURE_FIELDS.map(function (f) {
      return '<div class="detail-item"><span>' + f.label + '</span><strong>' + (m[f.key] !== null && m[f.key] !== undefined ? m[f.key] + " سم" : "—") + '</strong></div>';
    }).join("");
    const customRows = (m.customFields || []).map(function (f) {
      return '<div class="detail-item"><span>' + escapeHtml(f.label) + '</span><strong>' + escapeHtml(f.value) + '</strong></div>';
    }).join("");

    openModal("تفاصيل المقاس", '' +
      '<div class="profile-view">' +
        '<div class="profile-info"><h4>' + (c ? escapeHtml(c.name) : "عميل محذوف") + '</h4><p>تاريخ القياس: ' + formatDateArabic(m.createdAt) + '</p></div>' +
        '<div class="profile-details">' + rows + customRows + '</div>' +
        (m.notes ? '<div class="detail-item" style="grid-column:1/-1"><span>ملاحظات</span><strong>' + escapeHtml(m.notes) + '</strong></div>' : '') +
        '<div class="modal-footer-actions">' +
          '<button type="button" class="btn btn-ghost" id="closeMeasureViewBtn">إغلاق</button>' +
          '<button type="button" class="btn btn-outline" id="printMeasureBtn"><svg class="btn-icon"><use href="#icon-print"></use></svg> طباعة المقاسات</button>' +
        '</div>' +
      '</div>'
    , function () {
      document.getElementById("closeMeasureViewBtn").addEventListener("click", closeModal);
      document.getElementById("printMeasureBtn").addEventListener("click", function () { printSingleMeasurement(m.id); });
    });
  }

  function renderMeasurements(filterText) {
    const searchInput = document.getElementById("measurementSearch");
    filterText = (filterText !== undefined ? filterText : searchInput.value).trim().toLowerCase();
    const tbody = document.querySelector("#measurementsTable tbody");
    tbody.innerHTML = "";

    const filtered = measurements.filter(function (m) {
      const c = findCustomer(m.customerId);
      if (!filterText) return true;
      return c && c.name.toLowerCase().includes(filterText);
    }).sort(function (a, b) { return b.seq - a.seq; });

    document.getElementById("measurementsEmpty").hidden = filtered.length > 0;

    filtered.forEach(function (m) {
      const c = findCustomer(m.customerId);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + (c ? escapeHtml(c.name) : "عميل محذوف") + "</td>" +
        "<td>" + (m.shoulders !== null && m.shoulders !== undefined ? m.shoulders : "—") + "</td>" +
        "<td>" + (m.focus !== null && m.focus !== undefined ? m.focus : "—") + "</td>" +
        "<td>" + (m.chest !== null && m.chest !== undefined ? m.chest : "—") + "</td>" +
        "<td>" + (m.sleeve !== null && m.sleeve !== undefined ? m.sleeve : "—") + "</td>" +
        "<td>" + (m.waistBelt !== null && m.waistBelt !== undefined ? m.waistBelt : "—") + "</td>" +
        "<td>" + (m.length !== null && m.length !== undefined ? m.length : "—") + "</td>" +
        "<td>" + formatDateArabic(m.createdAt) + "</td>" +
        '<td><div class="row-actions">' +
          '<button class="icon-btn view" title="عرض" data-action="view" data-id="' + m.id + '"><svg><use href="#icon-eye"></use></svg></button>' +
          '<button class="icon-btn edit" title="تعديل" data-action="edit" data-id="' + m.id + '"><svg><use href="#icon-edit"></use></svg></button>' +
          '<button class="icon-btn danger" title="حذف" data-action="delete" data-id="' + m.id + '"><svg><use href="#icon-trash"></use></svg></button>' +
        '</div></td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-action]").forEach(function (btn) {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      btn.addEventListener("click", function () {
        if (action === "view") viewMeasurement(id);
        if (action === "edit") openMeasurementForm(id);
        if (action === "delete") deleteMeasurement(id);
      });
    });
  }

  function initMeasurementsPage() {
    document.getElementById("addMeasurementBtn").addEventListener("click", function () { openMeasurementForm(null); });
    document.getElementById("measurementSearch").addEventListener("input", function () { renderMeasurements(this.value); });
  }

  /* =========================================================================
     القسم 13: صفحة الطلبات (Orders)
     ========================================================================= */
  function orderFormHtml(order) {
    order = order || {};
    const customerOptions = customers.map(function (c) {
      const selected = order.customerId === c.id ? "selected" : "";
      return '<option value="' + c.id + '" ' + selected + '>' + escapeHtml(c.name) + ' (#' + c.seq + ')</option>';
    }).join("");
    const statusOptions = ORDER_STATUSES.map(function (s) {
      const selected = (order.status || "جديد") === s ? "selected" : "";
      return '<option value="' + s + '" ' + selected + '>' + s + '</option>';
    }).join("");

    return '' +
      '<div class="field"><label>العميل *</label><select id="orderCustomer" required>' +
        '<option value="">— اختر العميل —</option>' + customerOptions +
      '</select></div>' +
      '<div class="form-row">' +
        '<div class="field"><label>تاريخ الطلب *</label><input type="date" id="orderDate" value="' + (order.orderDate || todayISO()) + '" required></div>' +
        '<div class="field"><label>تاريخ التسليم *</label><input type="date" id="deliveryDate" value="' + (order.deliveryDate || "") + '" required></div>' +
      '</div>' +
      '<div class="field"><label>حالة الطلب</label><select id="orderStatus">' + statusOptions + '</select></div>' +
      '<div class="field"><label>ملاحظات الطلب</label><textarea id="orderNotes" placeholder="تفاصيل إضافية عن الطلب...">' + escapeHtml(order.notes || "") + '</textarea></div>' +
      '<div class="modal-footer-actions">' +
        '<button type="button" class="btn btn-ghost" id="orderCancelBtn">إلغاء</button>' +
        '<button type="submit" class="btn btn-primary" id="orderSaveBtn"><svg class="btn-icon"><use href="#icon-check"></use></svg> حفظ الطلب</button>' +
      '</div>';
  }

  function openOrderForm(existingId) {
    const order = existingId ? orders.find(function (o) { return o.id === existingId; }) : null;
    const title = order ? "تعديل الطلب" : "إضافة طلب جديد";

    if (!customers.length) {
      showToast("يجب إضافة عميل أولاً قبل إنشاء طلب", "error");
      return;
    }

    openModal(title, '<form id="orderForm">' + orderFormHtml(order) + '</form>', function () {
      document.getElementById("orderCancelBtn").addEventListener("click", closeModal);
      document.getElementById("orderForm").addEventListener("submit", function (e) {
        e.preventDefault();
        const customerId = document.getElementById("orderCustomer").value;
        const orderDate = document.getElementById("orderDate").value;
        const deliveryDate = document.getElementById("deliveryDate").value;
        const status = document.getElementById("orderStatus").value;
        const notes = document.getElementById("orderNotes").value.trim();

        if (!customerId || !orderDate || !deliveryDate) { showToast("جميع الحقول المطلوبة يجب تعبئتها", "error"); return; }

        const saveBtn = document.getElementById("orderSaveBtn");
        saveBtn.disabled = true;
        setSyncStatus("saving");

        if (order) {
          db.collection(COLLECTIONS.orders).doc(order.id).update({
            customerId: customerId, orderDate: orderDate, deliveryDate: deliveryDate, status: status, notes: notes,
          }).then(function () { showToast("تم تحديث الطلب بنجاح"); closeModal(); })
            .catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        } else {
          db.collection(COLLECTIONS.orders).add({
            seq: nextSeq(orders), customerId: customerId, orderDate: orderDate,
            deliveryDate: deliveryDate, status: status, notes: notes,
          }).then(function () { showToast("تمت إضافة الطلب بنجاح"); closeModal(); })
            .catch(function (err) { showToast(translateFirebaseError(err), "error"); saveBtn.disabled = false; });
        }
      });
    });
  }

  function deleteOrder(id) {
    confirmAction("سيتم حذف هذا الطلب نهائيًا. هل تريد الاستمرار؟", function () {
      setSyncStatus("saving");
      db.collection(COLLECTIONS.orders).doc(id).delete()
        .then(function () { showToast("تم حذف الطلب", "info"); })
        .catch(function (err) { showToast(translateFirebaseError(err), "error"); });
    });
  }

  function renderOrders(filterText, statusFilter) {
    const searchInput = document.getElementById("orderSearch");
    const statusSelect = document.getElementById("orderStatusFilter");
    filterText = (filterText !== undefined ? filterText : searchInput.value).trim().toLowerCase();
    statusFilter = statusFilter !== undefined ? statusFilter : statusSelect.value;

    const tbody = document.querySelector("#ordersTable tbody");
    tbody.innerHTML = "";

    const filtered = orders.filter(function (o) {
      const c = findCustomer(o.customerId);
      const matchesText = !filterText || String(o.seq).includes(filterText) || (c && c.name.toLowerCase().includes(filterText));
      const matchesStatus = !statusFilter || o.status === statusFilter;
      return matchesText && matchesStatus;
    }).sort(function (a, b) { return b.seq - a.seq; });

    document.getElementById("ordersEmpty").hidden = filtered.length > 0;

    filtered.forEach(function (o) {
      const c = findCustomer(o.customerId);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>#" + o.seq + "</td>" +
        "<td>" + (c ? escapeHtml(c.name) : "عميل محذوف") + "</td>" +
        "<td>" + formatDateArabic(o.orderDate) + "</td>" +
        "<td>" + formatDateArabic(o.deliveryDate) + "</td>" +
        '<td><span class="badge ' + (STATUS_BADGE_CLASS[o.status] || "") + '">' + o.status + '</span></td>' +
        '<td><div class="row-actions">' +
          '<button class="icon-btn view" title="طباعة" data-action="print" data-id="' + o.id + '"><svg><use href="#icon-print"></use></svg></button>' +
          '<button class="icon-btn edit" title="تعديل" data-action="edit" data-id="' + o.id + '"><svg><use href="#icon-edit"></use></svg></button>' +
          '<button class="icon-btn danger" title="حذف" data-action="delete" data-id="' + o.id + '"><svg><use href="#icon-trash"></use></svg></button>' +
        '</div></td>';
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll("[data-action]").forEach(function (btn) {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      btn.addEventListener("click", function () {
        if (action === "edit") openOrderForm(id);
        if (action === "delete") deleteOrder(id);
        if (action === "print") printSingleOrder(id);
      });
    });
  }

  function initOrdersPage() {
    document.getElementById("addOrderBtn").addEventListener("click", function () { openOrderForm(null); });
    document.getElementById("orderSearch").addEventListener("input", function () { renderOrders(this.value, undefined); });
    document.getElementById("orderStatusFilter").addEventListener("change", function () { renderOrders(undefined, this.value); });
  }

  /* =========================================================================
     القسم 14: التقارير (Reports)
     ========================================================================= */
  function buildCustomersReportTable() {
    let rows = customers.slice().sort(function (a, b) { return a.seq - b.seq; }).map(function (c) {
      return "<tr><td>#" + c.seq + "</td><td>" + escapeHtml(c.name) + "</td><td>" + escapeHtml(c.phone) + "</td><td>" + (escapeHtml(c.address) || "—") + "</td><td>" + formatDateArabic(c.createdAt) + "</td></tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="5" style="text-align:center;color:var(--text-faint)">لا توجد بيانات</td></tr>';
    return '<table class="data-table"><thead><tr><th>رقم العميل</th><th>الاسم الكامل</th><th>رقم الهاتف</th><th>العنوان</th><th>تاريخ التسجيل</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function buildOrdersReportTable() {
    let rows = orders.slice().sort(function (a, b) { return a.seq - b.seq; }).map(function (o) {
      const c = findCustomer(o.customerId);
      return "<tr><td>#" + o.seq + "</td><td>" + (c ? escapeHtml(c.name) : "—") + "</td><td>" + formatDateArabic(o.orderDate) + "</td><td>" + formatDateArabic(o.deliveryDate) + '</td><td><span class="badge ' + (STATUS_BADGE_CLASS[o.status] || "") + '">' + o.status + "</span></td></tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="5" style="text-align:center;color:var(--text-faint)">لا توجد بيانات</td></tr>';
    return '<table class="data-table"><thead><tr><th>رقم الطلب</th><th>العميل</th><th>تاريخ الطلب</th><th>تاريخ التسليم</th><th>الحالة</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function buildMeasurementsReportTable() {
    let rows = measurements.slice().sort(function (a, b) { return a.seq - b.seq; }).map(function (m) {
      const c = findCustomer(m.customerId);
      return "<tr><td>" + (c ? escapeHtml(c.name) : "—") + "</td><td>" + (m.shoulders ?? "—") + "</td><td>" + (m.focus ?? "—") + "</td><td>" + (m.chest ?? "—") + "</td><td>" + (m.sleeve ?? "—") + "</td><td>" + (m.waistBelt ?? "—") + "</td><td>" + (m.length ?? "—") + "</td><td>" + formatDateArabic(m.createdAt) + "</td></tr>";
    }).join("");
    if (!rows) rows = '<tr><td colspan="8" style="text-align:center;color:var(--text-faint)">لا توجد بيانات</td></tr>';
    return '<table class="data-table"><thead><tr><th>العميل</th><th>الأكتاف</th><th>التركيز</th><th>الصدر</th><th>الكم</th><th>الحزام</th><th>الطول</th><th>تاريخ القياس</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  const REPORT_BUILDERS = { customers: buildCustomersReportTable, orders: buildOrdersReportTable, measurements: buildMeasurementsReportTable };
  const REPORT_TITLES = { customers: "تقرير العملاء", orders: "تقرير الطلبات", measurements: "تقرير المقاسات" };
  let currentReportType = null;

  function showReport(type) {
    currentReportType = type;
    document.getElementById("reportResultCard").hidden = false;
    document.getElementById("reportResultTitle").textContent = REPORT_TITLES[type];
    document.getElementById("reportResultBody").innerHTML = REPORT_BUILDERS[type]();
    document.getElementById("reportResultCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initReportsPage() {
    document.querySelectorAll("[data-report]").forEach(function (btn) {
      btn.addEventListener("click", function () { showReport(this.dataset.report); });
    });
    document.querySelectorAll("[data-print-report]").forEach(function (btn) {
      btn.addEventListener("click", function () { printReport(this.dataset.printReport); });
    });
    document.getElementById("printCurrentReportBtn").addEventListener("click", function () {
      if (currentReportType) printReport(currentReportType);
    });
  }

  /* =========================================================================
     القسم 15: الطباعة (Print)
     ========================================================================= */
  function triggerPrint(titleHtml, bodyHtml) {
    const printArea = document.getElementById("printArea");
    printArea.innerHTML =
      '<h2>' + titleHtml + '</h2>' +
      '<p class="print-meta">تاريخ الطباعة: ' + formatDateArabic(todayISO()) + ' — الخيط الذهبي لإدارة محلات الخياطة</p>' +
      bodyHtml;
    window.print();
  }

  function printReport(type) {
    triggerPrint(REPORT_TITLES[type], REPORT_BUILDERS[type]());
  }

  function printCustomer(id) {
    const c = findCustomer(id);
    if (!c) return;
    const body =
      '<table><tbody>' +
      '<tr><th>رقم العميل</th><td>#' + c.seq + '</td></tr>' +
      '<tr><th>الاسم الكامل</th><td>' + escapeHtml(c.name) + '</td></tr>' +
      '<tr><th>رقم الهاتف</th><td>' + escapeHtml(c.phone) + '</td></tr>' +
      '<tr><th>العنوان</th><td>' + (escapeHtml(c.address) || "—") + '</td></tr>' +
      '<tr><th>ملاحظات</th><td>' + (escapeHtml(c.notes) || "—") + '</td></tr>' +
      '<tr><th>تاريخ التسجيل</th><td>' + formatDateArabic(c.createdAt) + '</td></tr>' +
      '</tbody></table>';
    triggerPrint("بطاقة بيانات العميل", body);
  }

  function printSingleMeasurement(id) {
    const m = measurements.find(function (x) { return x.id === id; });
    if (!m) return;
    const c = findCustomer(m.customerId);
    let rows = STANDARD_MEASURE_FIELDS.map(function (f) {
      return "<tr><th>" + f.label + "</th><td>" + (m[f.key] !== null && m[f.key] !== undefined ? m[f.key] + " سم" : "—") + "</td></tr>";
    }).join("");
    rows += (m.customFields || []).map(function (f) {
      return "<tr><th>" + escapeHtml(f.label) + "</th><td>" + escapeHtml(f.value) + "</td></tr>";
    }).join("");
    const body = '<p class="print-meta">العميل: ' + (c ? escapeHtml(c.name) : "—") + '</p><table><tbody>' + rows + '</tbody></table>';
    triggerPrint("بطاقة مقاسات العميل", body);
  }

  function printSingleOrder(id) {
    const o = orders.find(function (x) { return x.id === id; });
    if (!o) return;
    const c = findCustomer(o.customerId);
    const body =
      '<table><tbody>' +
      '<tr><th>رقم الطلب</th><td>#' + o.seq + '</td></tr>' +
      '<tr><th>العميل</th><td>' + (c ? escapeHtml(c.name) : "—") + '</td></tr>' +
      '<tr><th>رقم الهاتف</th><td>' + (c ? escapeHtml(c.phone) : "—") + '</td></tr>' +
      '<tr><th>تاريخ الطلب</th><td>' + formatDateArabic(o.orderDate) + '</td></tr>' +
      '<tr><th>تاريخ التسليم</th><td>' + formatDateArabic(o.deliveryDate) + '</td></tr>' +
      '<tr><th>حالة الطلب</th><td>' + o.status + '</td></tr>' +
      '<tr><th>ملاحظات</th><td>' + (escapeHtml(o.notes) || "—") + '</td></tr>' +
      '</tbody></table>';
    triggerPrint("إيصال الطلب", body);
  }

  /* =========================================================================
     القسم 16: الإعدادات (تصدير/استيراد البيانات، حساب المستخدم، حذف الكل)
     ========================================================================= */
  function initSettingsPage() {
    document.getElementById("exportDataBtn").addEventListener("click", function () {
      const payload = {
        exportedAt: new Date().toISOString(),
        customers: customers, measurements: measurements, orders: orders,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tailor-data-" + todayISO() + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("تم تصدير البيانات بنجاح");
    });

    const importInput = document.getElementById("importFileInput");
    document.getElementById("importDataBtn").addEventListener("click", function () { importInput.click(); });
    importInput.addEventListener("change", function () {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const data = JSON.parse(e.target.result);
          confirmAction("سيتم إضافة البيانات المستوردة إلى البيانات الحالية في Firestore (لن يتم حذف أي شيء). هل تريد الاستمرار؟", function () {
            importBulkData(data);
          });
        } catch (err) {
          showToast("ملف غير صالح، تعذر استيراد البيانات", "error");
        }
        importInput.value = "";
      };
      reader.readAsText(file);
    });

    document.getElementById("resetAllBtn").addEventListener("click", function () {
      confirmAction("سيتم حذف جميع العملاء والمقاسات والطلبات بشكل نهائي من Firestore ولا يمكن التراجع. هل أنت متأكد؟", function () {
        deleteAllData();
      });
    });
  }

  // استيراد دفعي: يضيف كل سجل كوثيقة جديدة في Firestore (يحتفظ بالمعرّفات القديمة كحقل مرجعي فقط)
  function importBulkData(data) {
    setSyncStatus("saving");
    const batch = db.batch();
    let opCount = 0;

    (Array.isArray(data.customers) ? data.customers : []).forEach(function (c) {
      const ref = db.collection(COLLECTIONS.customers).doc();
      const copy = Object.assign({}, c);
      delete copy.id;
      copy.seq = nextSeq(customers) + opCount;
      batch.set(ref, copy);
      opCount++;
    });
    (Array.isArray(data.measurements) ? data.measurements : []).forEach(function (m) {
      const ref = db.collection(COLLECTIONS.measurements).doc();
      const copy = Object.assign({}, m);
      delete copy.id;
      copy.seq = nextSeq(measurements) + opCount;
      batch.set(ref, copy);
      opCount++;
    });
    (Array.isArray(data.orders) ? data.orders : []).forEach(function (o) {
      const ref = db.collection(COLLECTIONS.orders).doc();
      const copy = Object.assign({}, o);
      delete copy.id;
      copy.seq = nextSeq(orders) + opCount;
      batch.set(ref, copy);
      opCount++;
    });

    if (opCount === 0) { showToast("لا توجد بيانات صالحة في الملف المستورد", "error"); return; }

    batch.commit()
      .then(function () { showToast("تم استيراد البيانات بنجاح"); })
      .catch(function (err) { showToast(translateFirebaseError(err), "error"); });
  }

  function deleteAllData() {
    setSyncStatus("saving");
    const collections = [COLLECTIONS.customers, COLLECTIONS.measurements, COLLECTIONS.orders];
    const deletions = collections.map(function (colName) {
      return db.collection(colName).get().then(function (snap) {
        const batch = db.batch();
        snap.docs.forEach(function (doc) { batch.delete(doc.ref); });
        return batch.commit();
      });
    });
    Promise.all(deletions)
      .then(function () { showToast("تم حذف جميع البيانات", "info"); })
      .catch(function (err) { showToast(translateFirebaseError(err), "error"); });
  }

  /* =========================================================================
     القسم 17: تطبيق الويب التقدمي (PWA) - التثبيت على الشاشة الرئيسية
     ========================================================================= */
  let deferredInstallPrompt = null;

  function initPwaInstall() {
    const sidebarBtn = document.getElementById("installAppBtn");
    const loginBtn = document.getElementById("installAppBtnLogin");

    // المتصفح يرسل هذا الحدث فقط إذا توفرت شروط التثبيت (manifest + service worker)
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault(); // نمنع الشريط التلقائي لنعرض زرنا الخاص بدلاً منه
      deferredInstallPrompt = e;
      sidebarBtn.hidden = false;
      loginBtn.hidden = false;
    });

    function triggerInstall() {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function (choice) {
        if (choice.outcome === "accepted") {
          showToast("تم بدء تثبيت التطبيق");
        }
        deferredInstallPrompt = null;
        sidebarBtn.hidden = true;
        loginBtn.hidden = true;
      });
    }

    sidebarBtn.addEventListener("click", triggerInstall);
    loginBtn.addEventListener("click", triggerInstall);

    // بعد التثبيت الفعلي (مهما كانت الطريقة)، نخفي الأزرار نهائيًا لهذه الجلسة
    window.addEventListener("appinstalled", function () {
      sidebarBtn.hidden = true;
      loginBtn.hidden = true;
      deferredInstallPrompt = null;
      showToast("تم تثبيت التطبيق على شاشتك الرئيسية بنجاح");
    });

    // إذا كان التطبيق يعمل بالفعل بصيغة standalone (مثبَّت مسبقًا)، لا تُظهر الأزرار أبدًا
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (isStandalone) {
      sidebarBtn.hidden = true;
      loginBtn.hidden = true;
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // التسجيل عبر مسار نسبي حتى يعمل بشكل صحيح من أي مجلد فرعي يتم رفع المشروع إليه
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.warn("تعذر تسجيل Service Worker:", err);
    });
  }

  /* =========================================================================
     القسم 18: بدء التطبيق
     ========================================================================= */
  function init() {
    initAuth();
    initNavigation();
    initTheme();
    initModalShell();
    initCustomersPage();
    initMeasurementsPage();
    initOrdersPage();
    initReportsPage();
    initSettingsPage();
    initPwaInstall();
    registerServiceWorker();
  }

  init();
});
