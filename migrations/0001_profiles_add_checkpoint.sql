-- profiles 에 마지막 갱신 시점의 메시지 수를 기록한다.
-- maybeUpdateMemory 가 "정확히 N의 배수" 대신 "마지막 갱신 이후 N개 누적" 으로
-- 판단하도록 바뀌면서 필요해졌다. 추가 전용이라 기존 데이터에 영향 없음.
ALTER TABLE profiles ADD COLUMN message_count_at_update INTEGER DEFAULT 0;
