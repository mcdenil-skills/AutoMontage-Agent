const { normalizeText } = require('./text');

function promiseChanged(passport, currentQuote) {
  if (currentQuote === undefined || !passport.promise.quote) return false;
  if (currentQuote === null) return !passport.promise.acknowledged.includes('');
  const current = normalizeText(currentQuote);
  return current !== normalizeText(passport.promise.quote) && !passport.promise.acknowledged.includes(current);
}

// Статусы – те же три раздела, что у видео: waiting (ход пользователя), working (ход агента), ready.
function deriveLeadMagnetStatus({ passport, newComments, checkOk, currentQuote }) {
  if (promiseChanged(passport, currentQuote)) {
    return { status: 'waiting', nextStep: 'Обещание в ролике изменилось – проверьте лид-магнит', approvable: false, promiseChanged: true };
  }
  if (newComments > 0) {
    return { status: 'working', nextStep: `Лид-магнит: ждёт агента, правок: ${newComments}`, approvable: false };
  }
  if (passport.approved !== null && passport.approved === passport.current) {
    return { status: 'ready', nextStep: 'Лид-магнит утверждён', approvable: false };
  }
  if (passport.current !== null) {
    return checkOk
      ? { status: 'waiting', nextStep: 'Лид-магнит: посмотрите и утвердите', approvable: true }
      : { status: 'working', nextStep: 'Лид-магнит: проверка не пройдена – агент исправляет', approvable: false };
  }
  return { status: 'working', nextStep: 'Агент готовит лид-магнит', approvable: false };
}

module.exports = { deriveLeadMagnetStatus };
