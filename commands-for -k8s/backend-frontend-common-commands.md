# Backend 與 Frontend 共用指令

> 範圍：backend、frontend 兩個服務在 Docker Compose 與 kubectl 底下的操作動詞完全相同，差別只在服務名稱。
> 對應資源：`docker-compose.yaml`（backend/frontend 兩個 service）、`k8s/backend.yaml`、`k8s/frontend.yaml`。

## Docker Compose 共用指令

```bash
# 建置 backend 映像檔（讀取 docker-compose.yaml 內 backend 區塊的 build context 與 args）
docker compose build backend

# 建置 frontend 映像檔，指令寫法與 backend 完全相同，只差服務名稱
docker compose build frontend

# 啟動 backend 容器（映像檔不存在時會自動建置），並以背景模式執行
docker compose up -d backend

# 啟動 frontend 容器，寫法與 backend 相同
docker compose up -d frontend

# 即時查看 backend 容器的輸出紀錄，確認程式是否正常啟動、healthcheck 是否通過
docker compose logs -f backend

# 即時查看 frontend 容器的輸出紀錄，寫法相同
docker compose logs -f frontend

# 進入 backend 容器內部的 shell，方便手動檢查檔案、環境變數
docker compose exec backend sh

# 進入 frontend 容器內部的 shell，寫法相同
docker compose exec frontend sh

# 重新啟動 backend 容器（不重新建置映像檔，只重啟 process）
docker compose restart backend

# 重新啟動 frontend 容器，寫法相同
docker compose restart frontend

# 停止並移除 backend 容器（image 與 volume 保留）
docker compose stop backend

# 停止並移除 frontend 容器，寫法相同
docker compose stop frontend
```

## Kubernetes 共用指令

```bash
# 套用 backend 的 Deployment 與 Service 設定到叢集
kubectl apply -f k8s/backend.yaml

# 套用 frontend 的 Deployment 與 Service 設定，寫法與 backend 相同
kubectl apply -f k8s/frontend.yaml

# 查看 backend 目前運行中的 pod 清單與狀態（Running/CrashLoopBackOff 等）
kubectl get pods -l app=backend

# 查看 frontend 目前運行中的 pod 清單，寫法相同
kubectl get pods -l app=frontend

# 即時查看 backend pod 的容器日誌
kubectl logs -f deployment/backend-deployment

# 即時查看 frontend pod 的容器日誌，寫法相同
kubectl logs -f deployment/frontend-deployment

# 進入 backend pod 內部的 shell 手動除錯
kubectl exec -it deployment/backend-deployment -- sh

# 進入 frontend pod 內部的 shell，寫法相同
kubectl exec -it deployment/frontend-deployment -- sh

# 將 backend-service 轉發到本機 8080 port，方便本機直接呼叫 API 測試
kubectl port-forward svc/backend-service 8080:8080

# 將 frontend-service 轉發到本機 8081 port，寫法相同（只是本機對外 port 不同，避免跟 backend 衝突）
kubectl port-forward svc/frontend-service 8081:80

# 在不改設定的情況下強制重建 backend 的 Pod，套用新版 Secret/ConfigMap 或排除異常
kubectl rollout restart deployment/backend-deployment

# 重新啟動 frontend 的 Deployment，寫法相同
kubectl rollout restart deployment/frontend-deployment

# 刪除 backend 的 Deployment 與 Service
kubectl delete -f k8s/backend.yaml

# 刪除 frontend 的 Deployment 與 Service，寫法相同
kubectl delete -f k8s/frontend.yaml
```
