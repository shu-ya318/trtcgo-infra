# Redis 與 SQL Server 分別配置寫法

> 比對對象：`k8s/redis.yaml` 與 `k8s/sqlserver.yaml`。
> 範圍：兩邊各自獨有、對方沒有對應寫法的部分，分兩段列出，互不對應。

## Redis 專屬配置（redis.yaml）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-deploymentment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: docker.io/library/lookgo-redis:latest
          imagePullPolicy: IfNotPresent
          command: ["redis-server", "--requirepass", "$(REDIS_PASSWORD)"]  # 覆寫容器預設啟動指令，強制 redis-server 啟動時要求密碼登入，未設定此行密碼保護不會生效
          env:
            - name: REDIS_PASSWORD               # 提供給上面 command 的 $(REDIS_PASSWORD) 變數使用
              valueFrom:
                secretKeyRef:
                  name: redis-secret               # 從 redis-secret 這個 Secret 讀值
                  key: redis-password                # 讀取其中 redis-password 這個 key
            - name: REDISCLI_AUTH                 # redis-cli 工具會自動讀這個環境變數當密碼，讓下面的 probe 不用手動帶密碼
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: redis-password
          livenessProbe:
            exec:
              command: ["redis-cli", "--raw", "ping"]  # 用 redis-cli 對自己 ping，測資料庫是否存活（sqlserver 沒有這種 CLI 探測方式）
          # PVC 沒有指定 storageClassName，交由叢集預設/動態供應處理（sqlserver 則手動指定，見另一份檔案）
```

## SQL Server 專屬配置（sqlserver.yaml）

```yaml
apiVersion: v1
kind: PersistentVolume                    # redis 完全沒有這個資源，sqlserver 額外手刻了一顆 PV
metadata:
  name: sqlserver-pv
spec:
  storageClassName: standard               # 手動指定 storage class 名稱，需與 PVC 的設定相符才能綁定
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain      # Pod/PVC 刪除後，這顆實體儲存空間仍保留不會被清除，需人工回收
  capacity:
    storage: 2Gi                             # 手動宣告這顆 PV 提供的容量上限
  hostPath:
    path: /mnt/data/sqlserver                 # 直接使用節點本機磁碟路徑當儲存空間（僅限單節點測試環境，換節點資料就消失）
    type: DirectoryOrCreate                     # 若路徑不存在就自動建立資料夾

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sqlserver-pvc
spec:
  storageClassName: standard                 # 明確指定要綁定 standard 這個 storage class（redis-pvc 沒有這行，交由預設處理）
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 2Gi

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sqlserver-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sqlserver
  template:
    metadata:
      labels:
        app: sqlserver
    spec:
      securityContext:
        fsGroup: 10001                        # Pod 層級安全性設定，讓掛載進來的 volume 屬於 gid 10001，SQL Server 容器需要此群組權限才能寫入資料目錄（redis 沒有設定這個）
      containers:
        - name: sqlserver
          image: docker.io/library/lookgo-sqlserver:latest
          imagePullPolicy: IfNotPresent
          command: ["/bin/bash", "/opt/mssql-tools18/bin/init-db.sh"]  # 覆寫預設啟動指令，改執行自製初始化腳本（背景啟動 sqlservr、等待就緒、跑 init.sql）
          env:
            - name: ACCEPT_EULA                # 官方映像檔要求，必須明確同意授權條款才會啟動
              value: "Y"
            - name: MSSQL_SA_PASSWORD           # SQL Server 系統管理員密碼，給 init-db.sh 內的 sqlcmd 使用
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: sa-password
            - name: DB_NAME                     # 給初始化腳本用來建立指定名稱的資料庫
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-name
            - name: DB_USERNAME                 # 給初始化腳本用來建立應用程式專用的資料庫登入帳號
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-username
            - name: DB_PASSWORD                 # 對應上面帳號的密碼
              valueFrom:
                secretKeyRef:
                  name: sqlserver-secret
                  key: db-password
          livenessProbe:
            exec:
              command:
                - /bin/bash
                - -c
                - /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -Q "SELECT 1"  # 用 sqlcmd 對本機資料庫下查詢，能成功執行才算存活（redis 沒有對應的 SQL 查詢探針）
```
