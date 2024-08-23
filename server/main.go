package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"andidog.de/workboard/server/api"
	"andidog.de/workboard/server/database"
	"andidog.de/workboard/server/proto"
	"github.com/improbable-eng/grpc-web/go/grpcweb"
	"github.com/joho/godotenv"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

func main() {
	zapLogger, _ := zap.NewDevelopment()
	defer func() {
		err := zapLogger.Sync() // flushes buffer, if any
		if err != nil {
			fmt.Printf("Failed to flush logger: %s\n", err)
		}
	}()
	logger := zapLogger.Sugar()

	envFiles := []string{".env"}
	if _, err := os.Stat(".env-local"); err == nil || !errors.Is(err, os.ErrNotExist) {
		envFiles = append(envFiles, ".env-local")
	}
	err := godotenv.Load(envFiles...)
	if err != nil {
		log.Fatalf("Error loading env files (%v)", envFiles)
	}

	// Database
	databaseDir := os.Getenv("DATABASE_DIR")
	if databaseDir == "" {
		logger.Fatal("Missing DATABASE_DIR environment variable")
	}
	db, err := database.OpenDatabase(databaseDir)
	defer func() {
		err := db.Close()
		if err != nil {
			logger.Errorw("Failed to close database", "databaseDir", databaseDir, "err", err)
		}
	}()
	if err != nil {
		logger.Fatalw("Failed to open database", "databaseDir", databaseDir, "err", err)
	}

	// gRPC setup (TODO: only keep gRPC-Web)
	grpcListenAddress := os.Getenv("GRPC_LISTEN_STRING")
	if grpcListenAddress == "" {
		logger.Fatal("Missing GRPC_LISTEN_STRING environment variable")
	}
	grpcListener, err := net.Listen("tcp", grpcListenAddress)
	if err != nil {
		logger.Fatalw("Failed to listen", "err", err)
	}
	var opts []grpc.ServerOption
	grpcServer := grpc.NewServer(opts...)
	workboardServer, err := api.NewWorkboardServer(db, logger)
	if err != nil {
		logger.Fatalw("Failed to start", "err", err)
	}
	proto.RegisterWorkboardServer(grpcServer, workboardServer)

	gprcWebAllowedCorsOrigin := os.Getenv("GPRC_WEB_ALLOWED_CORS_ORIGIN")
	if gprcWebAllowedCorsOrigin == "" {
		logger.Fatal("Missing GPRC_WEB_ALLOWED_CORS_ORIGIN environment variable")
	}
	wrappedGrpcServer := grpcweb.WrapServer(grpcServer,
		grpcweb.WithCorsForRegisteredEndpointsOnly(false),
		grpcweb.WithOriginFunc(func(origin string) bool { return origin == gprcWebAllowedCorsOrigin }))
	handler := func(resp http.ResponseWriter, req *http.Request) {
		wrappedGrpcServer.ServeHTTP(resp, req)
	}
	grpcWebListenAddress := os.Getenv("GRPC_WEB_LISTEN_STRING")
	if grpcWebListenAddress == "" {
		logger.Fatal("Missing GRPC_WEB_LISTEN_STRING environment variable")
	}
	http2Server := http.Server{
		Addr:              grpcWebListenAddress,
		Handler:           http.HandlerFunc(handler),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       30 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)

	var wg sync.WaitGroup

	// Start gRPC server
	wg.Add(1)
	go func() {
		defer wg.Done()
		logger.Infow("Starting gRPC server", "address", grpcListener.Addr())
		if err := grpcServer.Serve(grpcListener); err != nil {
			logger.Fatalw("Failed to listen (gRPC)", "err", err)
		}
		logger.Info("gRPC server successfully shut down")
	}()

	// Start gRPC-Web server
	wg.Add(1)
	go func() {
		defer wg.Done()

		tlsCertFilePath := "../test-pki/localhost.crt"
		tlsKeyFilePath := "../test-pki/localhost.key"

		logger.Infow("Starting gRPC-Web server", "address", http2Server.Addr)

		if err := http2Server.ListenAndServeTLS(tlsCertFilePath, tlsKeyFilePath); err != nil {
			if !errors.Is(err, http.ErrServerClosed) {
				logger.Fatalw("Failed to start HTTP2 server", "err", err)
			}
		}
		logger.Info("gRPC-Web server successfully shut down")
	}()

	<-quit
	logger.Info("Got shutdown signal")

	logger.Info("Shutting down gRPC server")
	grpcServer.GracefulStop()
	logger.Info("Shutting down gRPC-Web server")
	err = http2Server.Shutdown(context.Background())
	if err != nil {
		logger.Errorw("Failed to shut down gRPC-Web server", "err", err)
	}

	wg.Wait()
	logger.Info("Servers stopped, quitting")
}
