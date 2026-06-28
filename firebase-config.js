/* =========================================================================
   ملف إعدادات الاتصال بـ Firebase
   هذا الملف يحتوي على بيانات الربط الخاصة بمشروعك على Firebase.
   تم تعبئته ببيانات مشروع "al-khayt-dahabi" الذي أنشأته.
   لا حاجة لتعديل أي شيء هنا إلا إذا غيّرت مشروع Firebase نفسه.
   ========================================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyA4iBr09XhPltswS81RoV8bln_hrSBd1pw",
  authDomain: "al-khayt-dahabi.firebaseapp.com",
  projectId: "al-khayt-dahabi",
  storageBucket: "al-khayt-dahabi.firebasestorage.app",
  messagingSenderId: "705650732725",
  appId: "1:705650732725:web:60438115be9f532b4ed8fc"
};

// تهيئة Firebase (مرة واحدة فقط، تُستخدم من app.js)
firebase.initializeApp(firebaseConfig);

// مراجع جاهزة لخدمتي المصادقة وقاعدة البيانات
const auth = firebase.auth();
const db = firebase.firestore();
