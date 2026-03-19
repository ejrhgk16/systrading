import { db } from './firebaseConfig.js';
import { collection, addDoc, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { consoleLogger } from '../common/logger.js';

async function getTradeStatus(docId){
    try {
        const snap = await getDoc(doc(db, "trade_status", docId)); //문서아이디로 조회
        if (snap.exists()) {
            return snap.data()
        }else{
            return null
        }
    }catch(e){
        consoleLogger.error('Error getting documents:', e);
    }
}

// Firestore에 문서를 설정하는 예제 함수 (사용자 지정 ID 또는 덮어쓰기/병합)
async function setTradeStatus(documentId, data, merge = true) { // merge 기본값을 true로 변경
    try {
        const docRef = doc(db, "trade_status", documentId);
        await setDoc(docRef, data, { merge: merge });
        return true;
    } catch (e) {
        consoleLogger.error('Error setting document:', e);
        return false;
    }
}

// 날짜를 YYYY-MM-DD 형식(UTC 기준)으로 반환하는 헬퍼 함수
function getFormattedDate() {
    const d = new Date();
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 'trade_logs/algo_symbol(문서)/날짜(컬렉션)' 계층 구조로 거래 로그를 추가하는 함수
 * @param {string} parentDocId - 부모 문서의 ID (예: 'algo2_BTCUSDT')
 * @param {object} data - 저장할 로그 데이터
 */
async function addTradeLog(parentDocId, data) {
    try {
        const dateStr = getFormattedDate(); // 예: "2024-05-21"

        // 1. 부모 문서 참조 생성 ('trade_logs' 컬렉션 아래에 위치)
        const parentDocRef = doc(db, 'trade_log', parentDocId);
        
        // 2. 부모 문서가 존재하도록 빈 객체로 생성/병합 (내용은 덮어쓰지 않음)
        await setDoc(parentDocRef, {}, { merge: true });

        // 3. 부모 문서 아래에 날짜 하위 컬렉션 참조 생성
        const logCollectionRef = collection(parentDocRef, dateStr);

        // 4. 날짜 하위 컬렉션에 로그 데이터 문서 추가
        const docRef = await addDoc(logCollectionRef, {
            ...data,
            timestamp: serverTimestamp()
        });
        
        return docRef.id;
    } catch (e) {
        consoleLogger.error('Error adding hierarchical log:', e);
    }
}

/**
 * 하위 컬렉션 문서 조회
 * 경로: trade_status/{parentDocId}/{subCollection}/{subDocId}
 */
async function getSubDoc(parentDocId, subCollection, subDocId) {
    try {
        const snap = await getDoc(doc(db, 'trade_status', parentDocId, subCollection, subDocId));
        if (snap.exists()) {
            return snap.data();
        } else {
            return null;
        }
    } catch (e) {
        consoleLogger.error('Error getting sub document:', e);
    }
}

/**
 * 하위 컬렉션 문서 저장
 * 경로: trade_status/{parentDocId}/{subCollection}/{subDocId}
 */
async function setSubDoc(parentDocId, subCollection, subDocId, data, merge = true) {
    try {
        const docRef = doc(db, 'trade_status', parentDocId, subCollection, subDocId);
        await setDoc(docRef, data, { merge });
        return true;
    } catch (e) {
        consoleLogger.error('Error setting sub document:', e);
        return false;
    }
}

export { getTradeStatus, setTradeStatus, addTradeLog, getSubDoc, setSubDoc };
