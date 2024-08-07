package main

import (
	"context"
	"errors"
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
	"google.golang.org/grpc"
)

func main() {
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
		log.Fatal("Missing DATABASE_DIR environment variable")
	}
	db, err := database.OpenDatabase(databaseDir)
	defer func() {
		err := db.Close()
		if err != nil {
			log.Printf("Failed to close database %q: %s", databaseDir, err)
		}
	}()
	if err != nil {
		log.Fatalf("Failed to open database %q: %s", databaseDir, err)
	}

	// gRPC setup (TODO: only keep gRPC-Web)
	grpcListenAddress := os.Getenv("GRPC_LISTEN_STRING")
	if grpcListenAddress == "" {
		log.Fatal("Missing GRPC_LISTEN_STRING environment variable")
	}
	grpcListener, err := net.Listen("tcp", grpcListenAddress)
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}
	var opts []grpc.ServerOption
	grpcServer := grpc.NewServer(opts...)
	workboardServer, err := api.NewWorkboardServer(db)
	if err != nil {
		log.Fatalf("Failed to start: %v", err)
	}
	proto.RegisterWorkboardServer(grpcServer, workboardServer)

	gprcWebAllowedCorsOrigin := os.Getenv("GPRC_WEB_ALLOWED_CORS_ORIGIN")
	if gprcWebAllowedCorsOrigin == "" {
		log.Fatal("Missing GPRC_WEB_ALLOWED_CORS_ORIGIN environment variable")
	}
	wrappedGrpcServer := grpcweb.WrapServer(grpcServer,
		grpcweb.WithCorsForRegisteredEndpointsOnly(false),
		grpcweb.WithOriginFunc(func(origin string) bool { return origin == gprcWebAllowedCorsOrigin }))
	handler := func(resp http.ResponseWriter, req *http.Request) {
		wrappedGrpcServer.ServeHTTP(resp, req)
	}
	grpcWebListenAddress := os.Getenv("GRPC_WEB_LISTEN_STRING")
	if grpcWebListenAddress == "" {
		log.Fatal("Missing GRPC_WEB_LISTEN_STRING environment variable")
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
		log.Printf("Starting gRPC server on %s", grpcListener.Addr())
		if err := grpcServer.Serve(grpcListener); err != nil {
			log.Fatalf("Failed to listen (gRPC): %s\n", err)
		}
		log.Printf("gRPC server successfully shut down")
	}()

	// Start gRPC-Web server
	wg.Add(1)
	go func() {
		defer wg.Done()

		tlsCertFilePath := "../test-pki/localhost.crt"
		tlsKeyFilePath := "../test-pki/localhost.key"

		log.Printf("Starting gRPC-Web server on %s", http2Server.Addr)

		if err := http2Server.ListenAndServeTLS(tlsCertFilePath, tlsKeyFilePath); err != nil {
			if !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("Failed to start HTTP2 server: %s", err)
			}
		}
		log.Printf("gRPC-Web server successfully shut down")
	}()

	<-quit
	log.Print("Got shutdown signal")

	log.Print("Shutting down gRPC server")
	grpcServer.GracefulStop()
	log.Print("Shutting down gRPC-Web server")
	err = http2Server.Shutdown(context.Background())
	if err != nil {
		log.Printf("Failed to shut down gRPC-Web server: %s", err)
	}

	wg.Wait()
	log.Println("Servers stopped, quitting")
}
